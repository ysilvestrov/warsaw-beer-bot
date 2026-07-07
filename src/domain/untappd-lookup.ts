import { Searcher, fuzzy } from 'fast-fuzzy';
import { breweryAliases, breweryAliasesMatch, breweryAliasContained, ABV_TOLERANCE, COLLAB_SEP, nameKeys, intersects, stripBreweryFromName } from './matcher';
import { normalizeBrewery, normalizeName, cleanSearchQuery } from './normalize';
import {
  buildSearchUrl,
  type SearchResult,
  type BeerSearch,
} from '../sources/untappd/search';
import { HttpError } from '../sources/http';
import { isBlockStatus } from '../sources/untappd/block';

const NAME_FUZZY_THRESHOLD = 0.85;
const NEAR_TOKEN_SIM = 0.75;
const LONG_TOKEN_LENGTH = 7;
interface FuzzyTarget {
  value: string;
  exactOnly: boolean;
}

export type LookupOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'not_found'; searchUrls: string[]; candidates: SearchResult[] }
  | { kind: 'transient'; error: unknown }
  | { kind: 'blocked'; searchUrl: string };

export interface LookupArgs {
  brewery: string;
  name: string;
  abv?: number | null;
  search: BeerSearch;
}

// Split a brewery name into individual parts for search queries.
// For non-collab breweries ("Magic Road Brewery") returns [brewery] unchanged.
// For collab breweries ("TankBusters/Blech.Brut/Yeast Side Labs Brewery")
// returns ["TankBusters", "Blech.Brut", "Yeast Side Labs Brewery"] so each
// part is tried as a separate Untappd search query. This avoids an unregistered
// collab partner poisoning the combined query to zero results.
function brewerySearchParts(brewery: string): string[] {
  const parts = brewery.split(COLLAB_SEP).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [brewery];
}

function fuzzyTargets(name: string, brewery: string): FuzzyTarget[] {
  const breweryNorm = normalizeBrewery(brewery);
  const targets = new Map<string, FuzzyTarget>();
  for (const [index, raw] of [name, ...name.split(COLLAB_SEP)].entries()) {
    const value = stripBreweryFromName(normalizeName(raw), breweryNorm);
    if (!value) continue;
    const tokenCount = value.split(' ').filter(Boolean).length;
    const exactOnly = index > 0 && tokenCount < 2;
    const existing = targets.get(value);
    targets.set(value, { value, exactOnly: (existing?.exactOnly ?? true) && exactOnly });
  }
  return Array.from(targets.values());
}

// Among equally-valid name matches, prefer one whose ABV is within tolerance of the
// input's; otherwise the first (results are latest-first from the search page).
// NOTE: Stage 2b uses a score-aware variant (topScore guard) instead; this helper is
// only for Stage 2a / relaxedExact, where all candidates are equally ranked.
function pickByAbv(results: SearchResult[], abv: number | null): SearchResult {
  if (abv != null) {
    const hit = results.find((r) => r.abv != null && Math.abs(r.abv - abv) <= ABV_TOLERANCE);
    if (hit) return hit;
  }
  return results[0];
}

function nameTokens(norm: string): string[] {
  return norm.split(' ').filter((t) => t.length >= 2);
}

function bestTokenScore(token: string, others: string[]): number {
  return Math.max(0, ...others.map((other) => fuzzy(token, other)));
}

function tokenCovered(token: string, others: string[]): boolean {
  return bestTokenScore(token, others) >= NEAR_TOKEN_SIM;
}

function coverageScore(needles: string[], haystack: string[]): number | null {
  if (needles.length === 0 || !needles.every((token) => tokenCovered(token, haystack))) {
    return null;
  }
  const total = needles.reduce((sum, token) => sum + bestTokenScore(token, haystack), 0);
  return total / needles.length;
}

function hasLongSharedToken(a: string[], b: string[]): boolean {
  return a.some((left) =>
    left.length >= LONG_TOKEN_LENGTH &&
    b.some((right) => right.length >= LONG_TOKEN_LENGTH && fuzzy(left, right) >= NEAR_TOKEN_SIM),
  );
}

function nearNameScore(targetValue: string, candidate: SearchResult, singletonStrictPool: boolean): number | null {
  const targetTokens = nameTokens(targetValue);
  if (targetTokens.length === 0) return null;

  const candidateNameNorm = normalizeName(candidate.beer_name);
  const candidateBreweryNorm = normalizeBrewery(candidate.brewery_name);
  const candidateVariants = new Set([
    candidateNameNorm,
    stripBreweryFromName(candidateNameNorm, candidateBreweryNorm),
  ]);

  let best: number | null = null;
  for (const variant of candidateVariants) {
    const candidateTokens = nameTokens(variant);
    if (candidateTokens.length === 0) continue;

    const targetCovered = coverageScore(targetTokens, candidateTokens);
    if (targetCovered != null) {
      const extraPenalty = Math.max(0, candidateTokens.length - targetTokens.length) * 0.03;
      const score = targetCovered - extraPenalty;
      best = best == null ? score : Math.max(best, score);
    }

    const candidateCovered = coverageScore(candidateTokens, targetTokens);
    if (candidateCovered != null) {
      const extraPenalty = Math.max(0, targetTokens.length - candidateTokens.length) * 0.03;
      const score = candidateCovered - extraPenalty;
      best = best == null ? score : Math.max(best, score);
    }

    // Last resort for reviewed one-candidate search results: the brewery gate is
    // strict and the names share a distinctive long token, but each side has one
    // extra descriptor ("Lagerbier ungespundet" vs "Schammelsdorfer Lagerbier").
    if (singletonStrictPool && hasLongSharedToken(targetTokens, candidateTokens)) {
      best = best == null ? 0.7 : Math.max(best, 0.7);
    }
  }

  return best;
}

function aliasTokensCoveredBy(tokens: string[], aliases: string[]): boolean {
  return aliases.some((alias) => {
    const aliasTokens = nameTokens(alias);
    return aliasTokens.length > 0 && aliasTokens.every((token) => tokenCovered(token, tokens));
  });
}

function swappedBrandNameScore(
  targetValue: string,
  inputBreweryAliases: string[],
  candidate: SearchResult,
): number | null {
  const targetTokens = nameTokens(targetValue);
  if (targetTokens.length === 0) return null;
  const candidateNameTokens = nameTokens(normalizeName(candidate.beer_name));
  const candidateBreweryAliases = breweryAliases(candidate.brewery_name);

  if (
    aliasTokensCoveredBy(candidateNameTokens, inputBreweryAliases) &&
    aliasTokensCoveredBy(targetTokens, candidateBreweryAliases)
  ) {
    return 0.72;
  }
  return null;
}

export async function lookupBeer(args: LookupArgs): Promise<LookupOutcome> {
  const { brewery, name, abv = null } = args;
  const inputBreweryAliases = breweryAliases(brewery);
  const targetNames = fuzzyTargets(name, brewery);
  const parts = brewerySearchParts(brewery);
  const triedUrls: string[] = [];
  const seenCandidates: SearchResult[] = [];

  for (const part of parts) {
    const query = cleanSearchQuery(part, name);
    triedUrls.push(buildSearchUrl(query)); // human-readable debug URL for enrich_failures

    let results: SearchResult[];
    try {
      results = await args.search.search(query);
    } catch (error) {
      if (error instanceof HttpError && isBlockStatus(error.status)) {
        return { kind: 'blocked', searchUrl: buildSearchUrl(query) };
      }
      return { kind: 'transient', error };
    }

    seenCandidates.push(...results);
    if (results.length === 0) continue;

    // Stage 1: brewery-match strength. Each result is `strict` (leading-prefix
    // overlap — full name path incl. fuzzy) or `relaxed` (#149 empty-input bypass /
    // #120 contained non-leading brewery token — EXACT name only, never approximate
    // fuzzy). breweryAliasesMatch is recomputed once per result here.
    const tagged = results.map((r) => {
      const cand = breweryAliases(r.brewery_name);
      const strict = breweryAliasesMatch(cand, inputBreweryAliases);
      const relaxed =
        !strict &&
        (inputBreweryAliases.length === 0 ||
          breweryAliasContained(cand, inputBreweryAliases));
      // #138B brand-as-beer-name: the brewery gate fails entirely, but the input
      // brewery (the shelf brand) appears as a token-run inside the candidate beer
      // name — Untappd files the beer under a parent company (Heineken Ireland —
      // Murphy's Irish Stout). Matched on an EXACT name only (Stage below).
      // Check whether an input-brewery alias is a token-run within the beer NAME
      // (note the args are reversed vs the relaxed call above; tokenSublist is
      // symmetric, so that ordering is fine).
      const brand =
        !strict &&
        !relaxed &&
        breweryAliasContained(inputBreweryAliases, [normalizeName(r.beer_name)]);
      return { r, strict, relaxed, brand };
    });
    const strictPool = tagged.filter((t) => t.strict).map((t) => t.r);
    const relaxedPool = tagged.filter((t) => t.relaxed).map((t) => t.r);
    const brandPool = tagged.filter((t) => t.brand).map((t) => t.r);
    if (strictPool.length === 0 && relaxedPool.length === 0 && brandPool.length === 0) continue;

    // Stage 2a: exact name-key intersection (order-insensitive, collab/bilingual
    // aware) on strict ∪ relaxed. Strict candidates come first, so the no-ABV
    // pickByAbv fallback keeps "strict wins"; with ABV evidence a relaxed exact-key
    // hit can win — intentional, since exact-key+ABV is stronger than exact-key alone.
    const inputKeys = nameKeys(name, brewery);
    const keyHits = [...strictPool, ...relaxedPool].filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), inputKeys),
    );
    if (keyHits.length > 0) return { kind: 'matched', result: pickByAbv(keyHits, abv) };

    // Stage 2a.5: reviewed near-name misses (#234), STRICT brewery only. This is
    // intentionally narrower than Stage 2b fuzzy search: it is token-order-insensitive,
    // permits small edit-distance drift per token, and allows candidate-side suffixes,
    // but never upgrades relaxed brewery hits to approximate matches.
    if (strictPool.length > 0) {
      const nearMatches = strictPool
        .flatMap((result) =>
          targetNames.flatMap((targetName) => {
            if (targetName.exactOnly) return [];
            const score =
              nearNameScore(targetName.value, result, strictPool.length === 1) ??
              swappedBrandNameScore(targetName.value, inputBreweryAliases, result);
            return score == null ? [] : [{ result, score }];
          }),
        )
        .sort((a, b) => b.score - a.score);
      if (nearMatches.length > 0) {
        const topScore = nearMatches[0].score;
        if (abv != null) {
          const abvHit = nearMatches.find(
            (match) =>
              match.score === topScore &&
              match.result.abv != null &&
              Math.abs(match.result.abv - abv) <= ABV_TOLERANCE,
          );
          if (abvHit) return { kind: 'matched', result: abvHit.result };
        }
        return { kind: 'matched', result: nearMatches[0].result };
      }
    }

    // Stage 2b: name fuzzy >= 0.85 — STRICT pool only (a relaxed brewery never
    // matches via approximate fuzzy).
    if (strictPool.length > 0) {
      const searcher = new Searcher(strictPool, {
        keySelector: (r) => normalizeName(r.beer_name),
        threshold: NAME_FUZZY_THRESHOLD,
        returnMatchData: true,
      });
      const matches = targetNames
        .flatMap((targetName) =>
          searcher
            .search(targetName.value)
            .filter(
              (m) => !targetName.exactOnly || normalizeName(m.item.beer_name) === targetName.value,
            ),
        )
        .sort((a, b) => b.score - a.score);
      if (matches.length > 0) {
        // ABV tiebreak: normalizeName strips vintage years, so different-year /
        // different-strength variants collapse to identical names and tie at the top
        // score. ABV is the only separating signal among the equally-scored top matches.
        const topScore = matches[0].score;
        if (abv != null) {
          const abvHit = matches.find(
            (m) =>
              m.score === topScore &&
              m.item.abv != null &&
              Math.abs(m.item.abv - abv) <= ABV_TOLERANCE,
          );
          if (abvHit) return { kind: 'matched', result: abvHit.item };
        }
        return { kind: 'matched', result: matches[0].item };
      }
    }

    // Relaxed pool: EXACT normalized-name equality only (never approximate fuzzy).
    // Recovers names that collapse below the key path — e.g. `KULTOWE PILS` → `kultowe`
    // (style-word dropped), `St-Feuillien Blonde` (candidate strips its embedded brewery).
    const relaxedTargetValues = new Set(targetNames.map((t) => t.value));
    const relaxedExact = relaxedPool.filter((r) =>
      relaxedTargetValues.has(normalizeName(r.beer_name)),
    );
    if (relaxedExact.length > 0) return { kind: 'matched', result: pickByAbv(relaxedExact, abv) };

    // #138B brand-as-beer-name: exact name-key intersection using the input name with
    // the brewery NOT stripped (so the brand stays in the key), against candidates whose
    // beer name contains the input brand. Exact only, never fuzzy (principle A). Evaluated
    // after strict/relaxed, so a real brewery match always wins.
    const brandKeys = nameKeys(name, '');
    const brandHits = brandPool.filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), brandKeys),
    );
    if (brandHits.length > 0) return { kind: 'matched', result: pickByAbv(brandHits, abv) };

    // No name match in this search part — fall through to the next part.
  }

  return { kind: 'not_found', searchUrls: triedUrls, candidates: seenCandidates };
}
