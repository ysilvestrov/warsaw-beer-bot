import { Searcher } from 'fast-fuzzy';
import { breweryAliases, breweryAliasesMatch, ABV_TOLERANCE, COLLAB_SEP, nameKeys, intersects } from './matcher';
import { normalizeName, stripBreweryNoise } from './normalize';
import {
  buildSearchUrl,
  parseSearchPage,
  type SearchResult,
} from '../sources/untappd/search';
import { HttpError } from '../sources/http';
import { isBlockStatus, isBlockPage } from '../sources/untappd/block';

const NAME_FUZZY_THRESHOLD = 0.85;

export type LookupOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'not_found' }
  | { kind: 'transient'; error: unknown }
  | { kind: 'blocked' };

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

export async function lookupBeer(args: LookupArgs): Promise<LookupOutcome> {
  const { brewery, name, abv = null, fetch } = args;
  const inputBreweryAliases = breweryAliases(brewery);
  const targetName = normalizeName(name);
  const parts = brewerySearchParts(brewery);

  for (const part of parts) {
    let html: string;
    try {
      html = await fetch(buildSearchUrl(`${stripBreweryNoise(part)} ${name}`.trim()));
    } catch (error) {
      if (error instanceof HttpError && isBlockStatus(error.status)) {
        return { kind: 'blocked' };
      }
      return { kind: 'transient', error };
    }

    if (isBlockPage(html)) return { kind: 'blocked' };

    const results = parseSearchPage(html);
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
    const matches = searcher.search(targetName);
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

  return { kind: 'not_found' };
}
