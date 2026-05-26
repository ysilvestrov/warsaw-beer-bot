import { Searcher } from 'fast-fuzzy';
import { breweryAliases } from './matcher';
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

export async function lookupBeer(args: LookupArgs): Promise<LookupOutcome> {
  const { brewery, name, fetch } = args;

  let html: string;
  try {
    html = await fetch(buildSearchUrl(`${brewery} ${name}`));
  } catch (error) {
    return { kind: 'transient', error };
  }

  const results = parseSearchPage(html);
  if (results.length === 0) return { kind: 'not_found' };

  // Stage 1: brewery hard-gate — alias overlap.
  const inputBreweryAliases = new Set(breweryAliases(brewery));
  const breweryPassed = results.filter((r) => {
    const candidateAliases = breweryAliases(r.brewery_name);
    return candidateAliases.some((x) => inputBreweryAliases.has(x));
  });
  if (breweryPassed.length === 0) return { kind: 'not_found' };

  // Stage 2: name fuzzy >= 0.85.
  const targetName = normalizeName(name);
  const searcher = new Searcher(breweryPassed, {
    keySelector: (r) => normalizeName(r.beer_name),
    threshold: NAME_FUZZY_THRESHOLD,
    returnMatchData: true,
  });
  const matches = searcher.search(targetName);
  if (matches.length === 0) return { kind: 'not_found' };

  return { kind: 'matched', result: matches[0].item };
}
