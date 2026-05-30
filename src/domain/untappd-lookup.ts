import { Searcher } from 'fast-fuzzy';
import { breweryAliases, COLLAB_SEP } from './matcher';
import { normalizeName } from './normalize';
import {
  buildSearchUrl,
  parseSearchPage,
  type SearchResult,
} from '../sources/untappd/search';

const NAME_FUZZY_THRESHOLD = 0.85;

export type LookupOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'not_found' }
  | { kind: 'transient'; error: unknown };

export interface LookupArgs {
  brewery: string;
  name: string;
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
  const { brewery, name, fetch } = args;
  const inputBreweryAliases = new Set(breweryAliases(brewery));
  const targetName = normalizeName(name);
  const parts = brewerySearchParts(brewery);

  for (const part of parts) {
    let html: string;
    try {
      html = await fetch(buildSearchUrl(`${part} ${name}`));
    } catch (error) {
      return { kind: 'transient', error };
    }

    const results = parseSearchPage(html);
    if (results.length === 0) continue;

    // Stage 1: brewery hard-gate — alias overlap.
    const breweryPassed = results.filter((r) => {
      const candidateAliases = breweryAliases(r.brewery_name);
      return candidateAliases.some((a) => inputBreweryAliases.has(a));
    });
    if (breweryPassed.length === 0) continue;

    // Stage 2: name fuzzy >= 0.85.
    const searcher = new Searcher(breweryPassed, {
      keySelector: (r) => normalizeName(r.beer_name),
      threshold: NAME_FUZZY_THRESHOLD,
      returnMatchData: true,
    });
    const matches = searcher.search(targetName);
    if (matches.length === 0) continue;

    return { kind: 'matched', result: matches[0].item };
  }

  return { kind: 'not_found' };
}
