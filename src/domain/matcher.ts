import { Searcher } from 'fast-fuzzy';
import { normalizeName, normalizeBrewery } from './normalize';

export interface CatalogBeer { id: number; brewery: string; name: string; }
export interface MatchResult { id: number; confidence: number; source: 'exact' | 'fuzzy'; }

const FUZZY_THRESHOLD = 0.85;

export function matchBeer(
  input: { brewery: string; name: string },
  catalog: CatalogBeer[],
): MatchResult | null {
  const nb = normalizeBrewery(input.brewery);
  const nn = normalizeName(input.name);

  const exact = catalog.find(
    (c) => normalizeBrewery(c.brewery) === nb && normalizeName(c.name) === nn,
  );
  if (exact) return { id: exact.id, confidence: 1, source: 'exact' };

  const pool = catalog.filter((c) => normalizeBrewery(c.brewery) === nb);
  const candidates = pool.length ? pool : catalog;
  const searcher = new Searcher(candidates, {
    keySelector: (c) => `${normalizeBrewery(c.brewery)} ${normalizeName(c.name)}`,
    threshold: FUZZY_THRESHOLD,
    returnMatchData: true,
  });
  const results = searcher.search(`${nb} ${nn}`);
  if (!results.length) return null;
  const best = results[0];
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
}
