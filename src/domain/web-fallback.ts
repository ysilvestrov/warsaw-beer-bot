// src/domain/web-fallback.ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { readWebTriedAt, stampWebTried } from '../storage/beers';
import { tryConsumeWebSearchQuota } from '../storage/web_search_quota';
import { isWebFallbackBlocked } from '../storage/enrich_failures';
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
import type { ResolvedBeer, WebResolver } from '../sources/websearch/resolver';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

const NAME_FUZZY_THRESHOLD = 0.85;
const RE_WEB_COOLDOWN_DAYS = 30;

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

export type GateStage = 'accept' | 'reject:brewery' | 'reject:name-token' | 'needs-abv';

// Refined B1, split so the ABV-dependent stage is separable: brewery-strict is
// ALWAYS required; then either the name gate passes (same-language) or there is
// distinctive token overlap, which alone is not enough — it must be corroborated
// by ABV ('needs-abv'). Never accept on abv alone. Hydration-free by construction,
// so runWebFallback can call it before paying for hydrateAbv.
export function evaluateCandidate(input: GateInput, cand: ResolvedBeer): GateStage {
  if (!breweryStrict(input, cand)) return 'reject:brewery';
  if (nameGatePass(input, cand)) return 'accept';
  if (!sharedLongToken(tokens(input.name), tokens(cand.beer_name))) return 'reject:name-token';
  return 'needs-abv';
}

// Whole-gate verdict for an ALREADY-hydrated candidate. Thin wrapper over the
// core so the two can no longer drift.
export function gateWebCandidate(input: GateInput, cand: ResolvedBeer): boolean {
  const stage = evaluateCandidate(input, cand);
  if (stage === 'accept') return true;
  if (stage !== 'needs-abv') return false;
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

export interface WebFallbackDeps {
  db: DB;
  resolver: WebResolver;
  hydrate: BeerSearch; // server-side Algolia — the ONLY source of candidate abv (Brave supplies none)
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

export async function runWebFallback(
  deps: WebFallbackDeps,
  input: { beerId: number; brewery: string; name: string; abv: number | null },
): Promise<SearchResult | null> {
  const now = (deps.now ?? (() => new Date()))();

  // Triage classes the metered path must never spend on. Checked first and for
  // free: no quota, and deliberately NO web_tried_at stamp, so a beer unblocked
  // by a later parser fix is retried on the next cron tick rather than 30 days
  // later (#351). Covers the relay path too, which never passes through
  // listLookupCandidates and was previously unfiltered even for `wontfix`.
  if (isWebFallbackBlocked(deps.db, input.beerId)) {
    deps.log.debug({ beerId: input.beerId, reason: 'review-class' }, 'web-fallback skipped');
    return null;
  }

  // Per-beer cooldown: don't re-spend a web search on the same orphan within 30 days.
  const triedAt = readWebTriedAt(deps.db, input.beerId);
  if (triedAt) {
    const ageDays = (now.getTime() - new Date(triedAt).getTime()) / 86_400_000;
    if (ageDays < RE_WEB_COOLDOWN_DAYS) {
      deps.log.debug({ beerId: input.beerId, reason: 'cooldown' }, 'web-fallback skipped');
      return null;
    }
  }

  // Daily budget guard (UTC day). Consume BEFORE the network call.
  if (!tryConsumeWebSearchQuota(deps.db, utcDay(now), deps.cap)) {
    deps.log.debug({ beerId: input.beerId, reason: 'quota' }, 'web-fallback skipped');
    return null;
  }

  let candidates: ResolvedBeer[];
  try {
    candidates = await deps.resolver.resolve(input.brewery, input.name);
  } finally {
    // A spent call marks the beer regardless of outcome (accept or reject).
    stampWebTried(deps.db, input.beerId, now.toISOString());
  }

  for (const cand of candidates) {
    const stage = evaluateCandidate(input, cand);
    if (stage === 'accept') return toSearchResult(cand);
    if (stage !== 'needs-abv') continue;
    const abv = await hydrateAbv(deps.hydrate, cand);
    if (abvCorroborates(input.abv, abv)) return toSearchResult({ ...cand, abv });
  }
  return null;
}

// Runs `doLookup` (the normal matcher), and ONLY when it returns not_found with
// zero candidates — a genuine query-zeroing, not a matcher rejection of real
// candidates — invokes the web fallback. A fallback hit upgrades the outcome
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
