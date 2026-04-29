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

// Untappd records breweries either as a single name ("Piwne Podziemie Brewery")
// or as a "X / Y" alias used for two purposes:
//   • bilingual presentation — "Piwne Podziemie / Beer Underground", same brewery
//   • collaboration — "AleBrowar / Poppels Bryggeri", two different breweries
// Ontap.pl renders only one half. For matching purposes both cases collapse to:
// "the brewery on either side of '/' is also a valid brewery for this beer".
export function brewerySlashAliases(brewery: string): string[] {
  const full = normalizeBrewery(brewery);
  if (!brewery.includes(' / ')) return full ? [full] : [];
  const parts = brewery.split(' / ').map((p) => normalizeBrewery(p)).filter(Boolean);
  const all = [full, ...parts].filter(Boolean);
  return Array.from(new Set(all));
}

function brewerySetsOverlap(a: string[], b: Set<string>): boolean {
  return a.some((x) => b.has(x));
}

export function matchBeer(
  input: { brewery: string; name: string; abv?: number | null },
  catalog: CatalogBeer[],
): MatchResult | null {
  const inputAliases = new Set(brewerySlashAliases(input.brewery));
  const nn = normalizeName(input.name);

  // Exact-normalized hits — multiple rows are common when Untappd has
  // several vintages of the same beer. Latest id first.
  const exacts = catalog
    .filter(
      (c) =>
        brewerySetsOverlap(brewerySlashAliases(c.brewery), inputAliases) &&
        normalizeName(c.name) === nn,
    )
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

  // Fuzzy fallback: prefer rows whose brewery aliases overlap the input's,
  // otherwise full catalog.
  const pool = catalog.filter((c) =>
    brewerySetsOverlap(brewerySlashAliases(c.brewery), inputAliases),
  );
  const candidates = pool.length ? pool : catalog;
  const searcher = new Searcher(candidates, {
    keySelector: (c) => `${normalizeBrewery(c.brewery)} ${normalizeName(c.name)}`,
    threshold: FUZZY_THRESHOLD,
    returnMatchData: true,
  });
  // Use the first alias as the search seed — full normalized brewery already
  // appears at index 0 of brewerySlashAliases when no slash is present.
  const seedBrewery = Array.from(inputAliases)[0] ?? '';
  const results = searcher.search(`${seedBrewery} ${nn}`);
  if (!results.length) return null;
  const best = results[0];
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
}
