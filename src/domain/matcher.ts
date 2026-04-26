import { Searcher } from 'fast-fuzzy';
import { normalizeName, normalizeBrewery } from './normalize';

export interface CatalogBeer {
  id: number;
  brewery: string;
  name: string;
  abv: number | null;
}

export interface MatchResult {
  id: number;
  confidence: number;
  source: 'exact' | 'fuzzy';
}

const FUZZY_THRESHOLD = 0.75;
const ABV_TOLERANCE = 0.3;

export function matchBeer(
  input: { brewery: string; name: string; abv?: number | null },
  catalog: CatalogBeer[],
): MatchResult | null {
  const nb = normalizeBrewery(input.brewery);
  const nn = normalizeName(input.name);

  // Exact-normalized hits — multiple rows are common when Untappd has
  // several vintages of the same beer. Latest id first.
  const exacts = catalog
    .filter((c) => normalizeBrewery(c.brewery) === nb && normalizeName(c.name) === nn)
    .sort((a, b) => b.id - a.id);

  if (exacts.length) {
    const wantAbv = input.abv ?? null;
    if (wantAbv !== null) {
      const abvHit = exacts.find(
        (c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE,
      );
      if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };
    }
    return { id: exacts[0].id, confidence: 1, source: 'exact' };
  }

  // Fuzzy fallback: prefer same-brewery pool, otherwise full catalog.
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
