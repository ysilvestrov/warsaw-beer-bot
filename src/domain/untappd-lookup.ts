import { Searcher } from 'fast-fuzzy';
import { breweryAliases, breweryAliasesMatch, breweryAliasContained, ABV_TOLERANCE, COLLAB_SEP, nameKeys, intersects, stripLeadingBrewery } from './matcher';
import { normalizeBrewery, normalizeName, stripBreweryNoise } from './normalize';
import {
  buildSearchUrl,
  parseSearchPage,
  type SearchResult,
} from '../sources/untappd/search';
import { HttpError } from '../sources/http';
import { isBlockStatus, isBlockPage } from '../sources/untappd/block';

const NAME_FUZZY_THRESHOLD = 0.85;
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
  fetch: (url: string) => Promise<string>;
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
    const value = stripLeadingBrewery(normalizeName(raw), breweryNorm);
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

export async function lookupBeer(args: LookupArgs): Promise<LookupOutcome> {
  const { brewery, name, abv = null, fetch } = args;
  const inputBreweryAliases = breweryAliases(brewery);
  const targetNames = fuzzyTargets(name, brewery);
  const parts = brewerySearchParts(brewery);
  const triedUrls: string[] = [];
  const seenCandidates: SearchResult[] = [];

  for (const part of parts) {
    const url = buildSearchUrl(`${stripBreweryNoise(part)} ${name}`.trim());
    triedUrls.push(url);

    let html: string;
    try {
      html = await fetch(url);
    } catch (error) {
      if (error instanceof HttpError && isBlockStatus(error.status)) {
        return { kind: 'blocked', searchUrl: url };
      }
      return { kind: 'transient', error };
    }

    if (isBlockPage(html)) return { kind: 'blocked', searchUrl: url };

    const results = parseSearchPage(html);
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
