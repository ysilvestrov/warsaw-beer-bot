// src/domain/google-fallback.ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { readWebTriedAt, stampWebTried } from '../storage/beers';
import { tryConsumeWebSearchQuota } from '../storage/web_search_quota';
import { utcDay } from './utc-day';
import { normalizeName } from './normalize';
import {
  ABV_TOLERANCE,
  breweryAliases,
  breweryAliasesMatch,
  nameKeys,
  intersects,
} from './matcher';
import { hasLongSharedToken } from './untappd-lookup';
import type { LookupOutcome } from './untappd-lookup';
import { fuzzy } from 'fast-fuzzy';
import type { ResolvedBeer, WebResolver } from '../sources/google/resolver';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

const NAME_FUZZY_THRESHOLD = 0.85;
const RE_GOOGLE_COOLDOWN_DAYS = 30;

interface GateInput { brewery: string; name: string; abv: number | null }

function breweryStrict(input: GateInput, cand: ResolvedBeer): boolean {
  return breweryAliasesMatch(breweryAliases(cand.brewery_name), breweryAliases(input.brewery));
}

function nameGatePass(input: GateInput, cand: ResolvedBeer): boolean {
  // Exact name-key intersection (order-insensitive) OR fuzzy >= 0.85 on the
  // brewery-stripped normalized names — the same signals the main matcher trusts.
  if (intersects(nameKeys(cand.beer_name, cand.brewery_name), nameKeys(input.name, input.brewery))) {
    return true;
  }
  return fuzzy(normalizeName(input.name), normalizeName(cand.beer_name)) >= NAME_FUZZY_THRESHOLD;
}

function tokens(s: string): string[] {
  return normalizeName(s).split(' ').filter((t) => t.length >= 2);
}

// hasLongSharedToken's inner fuzzy() call is directional (fast-fuzzy scores a
// "search term" against a "target", not a symmetric similarity), so a
// near-cognate pair can pass in one argument order and miss in the other
// (e.g. fuzzy('cynamon','cinnamon') = 0.714 vs fuzzy('cinnamon','cynamon') =
// 0.75, straddling the 0.75 NEAR_TOKEN_SIM threshold). Token overlap is
// conceptually a symmetric relation, so check both directions rather than
// let the accept/reject outcome depend on which side is "input" vs
// "candidate".
function sharedLongToken(a: string[], b: string[]): boolean {
  return hasLongSharedToken(a, b) || hasLongSharedToken(b, a);
}

function abvCorroborates(a: number | null, b: number | null): boolean {
  return a != null && b != null && Math.abs(a - b) <= ABV_TOLERANCE;
}

// Refined B1: brewery-strict ALWAYS required; then either the name gate passes
// (same-language) OR there is distinctive token overlap AND abv corroborates
// (cross-language). Never accept on abv alone. `cand.abv` must already be
// hydrated by the caller before the token-overlap branch is trusted.
export function gateGoogleCandidate(input: GateInput, cand: ResolvedBeer): boolean {
  if (!breweryStrict(input, cand)) return false;
  if (nameGatePass(input, cand)) return true;
  if (!sharedLongToken(tokens(input.name), tokens(cand.beer_name))) return false;
  return abvCorroborates(input.abv, cand.abv);
}

function toSearchResult(cand: ResolvedBeer): SearchResult {
  return {
    bid: cand.bid,
    beer_name: cand.beer_name,
    brewery_name: cand.brewery_name,
    style: null,
    abv: cand.abv,
    global_rating: null,
  };
}

export interface GoogleFallbackDeps {
  db: DB;
  resolver: WebResolver;
  hydrate: BeerSearch; // server-side Algolia, for abv hydration only
  cap: number;
  log: pino.Logger;
  now?: () => Date;
}

// Hydrate a null abv by searching Algolia for the resolved canonical name and
// taking the matching bid's abv. Best-effort: any miss leaves abv null (→ reject
// in the token-overlap branch), never throws into the caller.
async function hydrateAbv(hydrate: BeerSearch, cand: ResolvedBeer): Promise<number | null> {
  if (cand.abv != null) return cand.abv;
  try {
    const hits = await hydrate.search(cand.beer_name);
    const byId = hits.find((h) => h.bid === cand.bid);
    return (byId ?? hits[0])?.abv ?? null;
  } catch {
    return null;
  }
}

export async function runGoogleFallback(
  deps: GoogleFallbackDeps,
  input: { beerId: number; brewery: string; name: string; abv: number | null },
): Promise<SearchResult | null> {
  const now = (deps.now ?? (() => new Date()))();

  // Per-beer cooldown: don't re-spend Google on the same orphan within 30 days.
  const triedAt = readWebTriedAt(deps.db, input.beerId);
  if (triedAt) {
    const ageDays = (now.getTime() - new Date(triedAt).getTime()) / 86_400_000;
    if (ageDays < RE_GOOGLE_COOLDOWN_DAYS) return null;
  }

  // Daily budget guard (UTC day). Consume BEFORE the network call.
  if (!tryConsumeWebSearchQuota(deps.db, utcDay(now), deps.cap)) return null;

  let candidates: ResolvedBeer[];
  try {
    candidates = await deps.resolver.resolve(input.brewery, input.name);
  } finally {
    // A spent call marks the beer regardless of outcome (accept or reject).
    stampWebTried(deps.db, input.beerId, now.toISOString());
  }

  for (const cand of candidates) {
    if (!breweryStrict(input, cand)) continue;
    if (nameGatePass(input, cand)) return toSearchResult(cand);
    if (!sharedLongToken(tokens(input.name), tokens(cand.beer_name))) continue;
    const abv = await hydrateAbv(deps.hydrate, cand);
    if (abvCorroborates(input.abv, abv)) return toSearchResult({ ...cand, abv });
  }
  return null;
}

// Runs `doLookup` (the normal matcher), and ONLY when it returns not_found with
// zero candidates — a genuine query-zeroing, not a matcher rejection of real
// candidates — invokes the Google fallback. A fallback hit upgrades the outcome
// to matched; a miss (or fallback === null) leaves the original outcome intact.
export async function lookupWithFallback(
  doLookup: () => Promise<LookupOutcome>,
  beerId: number,
  fallback: ((beerId: number) => Promise<SearchResult | null>) | null,
): Promise<LookupOutcome> {
  const outcome = await doLookup();
  if (!fallback) return outcome;
  if (outcome.kind !== 'not_found' || outcome.candidates.length > 0) return outcome;
  const sr = await fallback(beerId);
  return sr ? { kind: 'matched', result: sr } : outcome;
}
