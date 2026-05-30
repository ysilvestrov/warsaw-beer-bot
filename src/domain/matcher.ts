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

// Separator regex for collab/bilingual brewery names. Untappd uses:
//   "A / B"  — slash with any spacing (bilingual or collab)
//   "A x B"  — " x "/" X " connector (collab, case-insensitive)
//   "A (B)"  — paren form for German aliases
// Ontap.pl renders only one side. All forms collapse to: "any side is valid".
export const COLLAB_SEP = /\s*\/\s*|\s+[Xx]\s+/;

export function breweryAliases(brewery: string): string[] {
  const aliases = new Set<string>();
  const full = normalizeBrewery(brewery);
  if (full) aliases.add(full);

  const collabParts = COLLAB_SEP.test(brewery) ? brewery.split(COLLAB_SEP) : [brewery];
  for (const part of collabParts) {
    const parenMatch = part.match(/^(.+?)\s*\((.+)\)\s*$/);
    if (parenMatch) {
      const outer = normalizeBrewery(parenMatch[1]);
      const inner = normalizeBrewery(parenMatch[2]);
      if (outer) aliases.add(outer);
      if (inner) aliases.add(inner);
    } else {
      const norm = normalizeBrewery(part);
      if (norm) aliases.add(norm);
    }
  }

  return Array.from(aliases);
}

function brewerySetsOverlap(a: string[], b: Set<string>): boolean {
  return a.some((x) => b.has(x));
}

export function matchBeer(
  input: { brewery: string; name: string; abv?: number | null },
  catalog: CatalogBeer[],
): MatchResult | null {
  const inputAliases = new Set(breweryAliases(input.brewery));
  const nn = normalizeName(input.name);

  // Exact-normalized hits — multiple rows are common when Untappd has
  // several vintages of the same beer. Latest id first.
  const exacts = catalog
    .filter(
      (c) =>
        brewerySetsOverlap(breweryAliases(c.brewery), inputAliases) &&
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
    brewerySetsOverlap(breweryAliases(c.brewery), inputAliases),
  );
  const candidates = pool.length ? pool : catalog;
  const searcher = new Searcher(candidates, {
    keySelector: (c) => `${normalizeBrewery(c.brewery)} ${normalizeName(c.name)}`,
    threshold: FUZZY_THRESHOLD,
    returnMatchData: true,
  });
  // Use the first alias as the search seed — full normalized brewery already
  // appears at index 0 of breweryAliases when no slash is present.
  const seedBrewery = Array.from(inputAliases)[0] ?? '';
  const results = searcher.search(`${seedBrewery} ${nn}`);
  if (!results.length) return null;
  const best = results[0];
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
}
