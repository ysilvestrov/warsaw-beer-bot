import { Searcher, fuzzy } from 'fast-fuzzy';
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
export const ABV_TOLERANCE = 0.3;

// A catalog row with its normalizations precomputed once, so a batch of input
// beers does not re-normalize the whole catalog per beer.
export interface PreparedBeer extends CatalogBeer {
  nameNorm: string;     // normalizeName(name)
  breweryNorm: string;  // normalizeBrewery(brewery)
  aliases: string[];    // breweryAliases(brewery)
}

function defaultBuildSearcher(rows: PreparedBeer[]) {
  return new Searcher(rows, {
    keySelector: (c) => `${c.breweryNorm} ${c.nameNorm}`,
    threshold: FUZZY_THRESHOLD,
    returnMatchData: true,
  });
}

type PreparedSearcher = ReturnType<typeof defaultBuildSearcher>;

// Build-once-per-request prepared catalog. `fullSearcher()` is memoized and built
// lazily — only the first empty-pool fuzzy fallback in a batch constructs the
// 20k-row index; if no beer falls through, it is never built.
export interface PreparedCatalog {
  beers: PreparedBeer[];
  searcherFor(rows: PreparedBeer[]): PreparedSearcher;
  fullSearcher(): PreparedSearcher;
}

// Per-row preparation: precompute the normalizations once.
export function prepareBeer(c: CatalogBeer): PreparedBeer {
  return {
    ...c,
    nameNorm: normalizeName(c.name),
    breweryNorm: normalizeBrewery(c.brewery),
    aliases: breweryAliases(c.brewery),
  };
}

// Assembles a PreparedCatalog from already-prepared rows. `build` is injectable
// purely so tests can observe Searcher construction; the default is the
// production builder. `fullSearcher()` is memoized + lazily built.
export function makePreparedCatalog(
  beers: PreparedBeer[],
  build: (rows: PreparedBeer[]) => PreparedSearcher = defaultBuildSearcher,
): PreparedCatalog {
  let full: PreparedSearcher | undefined;
  return {
    beers,
    searcherFor: build,
    fullSearcher: () => (full ??= build(beers)),
  };
}

export function prepareCatalog(
  catalog: CatalogBeer[],
  build: (rows: PreparedBeer[]) => PreparedSearcher = defaultBuildSearcher,
): PreparedCatalog {
  return makePreparedCatalog(catalog.map(prepareBeer), build);
}

// Separator regex for collab/bilingual brewery names. Untappd uses:
//   "A / B"  — slash with any spacing (bilingual or collab)
//   "A x B"  — " x "/" X " connector (collab, case-insensitive)
//   "A & B"  — " & " connector (collab)
//   "A (B)"  — paren form for German aliases
// Ontap.pl renders only one side. All forms collapse to: "any side is valid".
export const COLLAB_SEP = /\s*\/\s*|\s+[Xx]\s+|\s+&\s+/;

// Extracts the first 4-digit calendar year (1900–2099) from a raw beer name.
// Called on the un-normalized name because normalizeName strips digit tokens.
export function extractYear(name: string): number | null {
  const m = name.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

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

// Token-boundary prefix: true if `a`'s tokens are a leading prefix of `b`'s,
// or vice versa. Compares whole tokens, so "harp" never matches "harpagan".
function tokenPrefix(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const ta = a.split(' ');
  const tb = b.split(' ');
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((t, i) => t === long[i]);
}

// True if any alias from one side is a token-prefix of any alias from the other.
export function breweryAliasesMatch(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => tokenPrefix(x, y)));
}

// Per-token similarity floor for the divergence guard. A token is "covered" by the
// other name when some token there scores at least this against it. 0.7 has wide margin:
// Polish inflections / typos score >= 0.83, distinct flavour words <= 0.2.
const TOKEN_SIM = 0.7;

// Drop sub-2-char fragments (e.g. the apostrophe-junk "s" from "s'mores" -> "s mores").
function divergenceTokens(name: string): string[] {
  return name.split(' ').filter((t) => t.length >= 2);
}

function tokenCovered(t: string, others: string[]): boolean {
  return others.some((o) => fuzzy(t, o) >= TOKEN_SIM);
}

// True when each normalized name has a content token the other side does not cover
// (fuzzily) — i.e. the names diverge rather than one being a subset/inflection of the
// other. Rejects fuzzy matches between different flavour variants that share a long base
// name ("vanilla mind over matter" vs "s mores mind over matter").
export function nameTokensDiverge(a: string, b: string): boolean {
  const ta = divergenceTokens(a);
  const tb = divergenceTokens(b);
  const aUncovered = ta.some((t) => !tokenCovered(t, tb));
  const bUncovered = tb.some((t) => !tokenCovered(t, ta));
  return aUncovered && bUncovered;
}

export function matchPrepared(
  input: { brewery: string; name: string; abv?: number | null },
  prepared: PreparedCatalog,
): MatchResult | null {
  const inputAliases = breweryAliases(input.brewery);
  const nn = normalizeName(input.name);
  const catalog = prepared.beers;

  // Exact-normalized hits — multiple rows are common when Untappd has
  // several vintages of the same beer. Latest id first.
  const exacts = catalog
    .filter(
      (c) =>
        breweryAliasesMatch(c.aliases, inputAliases) &&
        c.nameNorm === nn,
    )
    .sort((a, b) => b.id - a.id);

  if (exacts.length) {
    const wantAbv = input.abv ?? null;
    const inputYear = extractYear(input.name);

    if (inputYear === null) {
      // No year in input — original behaviour: ABV first, else most-recent.
      if (wantAbv !== null) {
        const abvHit = exacts.find(
          (c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE,
        );
        if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };
      }
      return { id: exacts[0].id, confidence: 1, source: 'exact' };
    }

    // Year found in input — partition candidates by vintage relationship.
    // exacts is already sorted id DESC so each filtered array preserves that order.
    const yearMatch = exacts.filter((c) => extractYear(c.name) === inputYear);
    const noYear    = exacts.filter((c) => extractYear(c.name) === null);
    const wrongYear = exacts.filter(
      (c) => { const y = extractYear(c.name); return y !== null && y !== inputYear; },
    );

    if (yearMatch.length > 0) {
      const candidate = yearMatch[0];
      const abvMismatch =
        wantAbv !== null &&
        candidate.abv !== null &&
        Math.abs(candidate.abv - wantAbv) > ABV_TOLERANCE;

      if (!abvMismatch) {
        return { id: candidate.id, confidence: 1, source: 'exact' };
      }

      // ABV mismatch on the year-matching row — likely an ontap data entry error.
      // Try other candidates that have a matching ABV: noYear first, then wrongYear.
      const abvHit =
        noYear.find((c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE) ??
        wrongYear.find((c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE);
      if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };

      // Nothing with a better ABV — accept the ontap ABV error, stay on year-match.
      return { id: candidate.id, confidence: 1, source: 'exact' };
    }

    // No same-year catalog entry — fall back to no-year entries if any exist.
    if (noYear.length > 0) {
      if (wantAbv !== null) {
        const abvHit = noYear.find(
          (c) => c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE,
        );
        if (abvHit) return { id: abvHit.id, confidence: 1, source: 'exact' };
      }
      return { id: noYear[0].id, confidence: 1, source: 'exact' };
    }

    // Only wrong-year candidates exist — do not cross-match vintages.
    return null;
  }

  // Fuzzy fallback: prefer rows whose brewery aliases overlap the input's,
  // otherwise the full catalog (shared, lazily-built Searcher).
  const pool = catalog.filter((c) => breweryAliasesMatch(c.aliases, inputAliases));
  const searcher = pool.length ? prepared.searcherFor(pool) : prepared.fullSearcher();
  // Use the first alias as the search seed — full normalized brewery already
  // appears at index 0 of breweryAliases when no slash is present.
  const seedBrewery = inputAliases[0] ?? '';
  const results = searcher.search(`${seedBrewery} ${nn}`);
  if (!results.length) return null;
  const best = results[0];
  // Reject a fuzzy candidate that diverges from the input on content tokens — a
  // different flavour variant of the same base beer (e.g. "Double Vanilla Mind Over
  // Matter" vs "S'mores Mind Over Matter"), which must not inherit drunk/rating data.
  if (nameTokensDiverge(nn, best.item.nameNorm)) return null;
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
}

// Back-compat single-beer entry point. Prepares the catalog per call, so callers
// that match many beers should call prepareCatalog once and loop matchPrepared.
export function matchBeer(
  input: { brewery: string; name: string; abv?: number | null },
  catalog: CatalogBeer[],
): MatchResult | null {
  return matchPrepared(input, prepareCatalog(catalog));
}
