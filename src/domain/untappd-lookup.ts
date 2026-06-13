import { Searcher } from 'fast-fuzzy';
import { breweryAliases, breweryAliasesMatch, ABV_TOLERANCE, COLLAB_SEP, nameKeys, intersects, stripLeadingBrewery } from './matcher';
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

    // Stage 1: brewery hard-gate — token-boundary prefix overlap.
    const breweryPassed = results.filter((r) =>
      breweryAliasesMatch(breweryAliases(r.brewery_name), inputBreweryAliases),
    );
    if (breweryPassed.length === 0) continue;

    // Stage 2a: name-keys exact intersection (order-insensitive, collab/bilingual aware).
    const inputKeys = nameKeys(name, brewery);
    const keyHits = breweryPassed.filter((r) =>
      intersects(nameKeys(r.beer_name, r.brewery_name), inputKeys),
    );
    if (keyHits.length > 0) {
      if (abv != null) {
        const abvHit = keyHits.find(
          (r) => r.abv != null && Math.abs(r.abv - abv) <= ABV_TOLERANCE,
        );
        if (abvHit) return { kind: 'matched', result: abvHit };
      }
      return { kind: 'matched', result: keyHits[0] };
    }

    // Stage 2b: name fuzzy >= 0.85.
    const searcher = new Searcher(breweryPassed, {
      keySelector: (r) => normalizeName(r.beer_name),
      threshold: NAME_FUZZY_THRESHOLD,
      returnMatchData: true,
    });
    const matches = targetNames
      .flatMap((targetName) =>
        searcher
          .search(targetName.value)
          .filter((m) => !targetName.exactOnly || normalizeName(m.item.beer_name) === targetName.value),
      )
      .sort((a, b) => b.score - a.score);
    if (matches.length === 0) continue;

    // ABV tiebreak: normalizeName strips vintage years, so different-year /
    // different-strength variants of the same beer collapse to identical names
    // and tie at the top score. ABV is the only signal that separates them, so
    // among the equally-scored top matches prefer one within ABV_TOLERANCE.
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

  return { kind: 'not_found', searchUrls: triedUrls, candidates: seenCandidates };
}
