import { Searcher, fuzzy } from 'fast-fuzzy';
import { normalizeName, normalizeBrewery, COLLAB_SEP, BREWERY_NOISE } from './normalize';
import { aliasNeighbors, aliasKeys } from './brewery-aliases';

export { COLLAB_SEP } from './normalize';

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

// Per-request cap on how many items may run the ~89ms/item full-catalog fuzzy
// fallback (#279). Beyond it, items return null (stay ⚪) instead of burning CPU.
export const FULL_FALLBACK_BUDGET = 20;

export interface FallbackBudget {
  remaining: number;      // full-catalog fallbacks still allowed
  attempts: number;       // items that reached the full-catalog path
  hits: number;           // of those, produced a non-null match
  budgetSkipped: number;  // items denied full search because budget was exhausted
}

export function createFallbackBudget(limit: number = FULL_FALLBACK_BUDGET): FallbackBudget {
  return { remaining: limit, attempts: 0, hits: 0, budgetSkipped: 0 };
}

export const ABV_TOLERANCE = 0.3;
const TRANSITIVE_SAFE_ALIAS_HUBS = new Set(['nepo']);

// A catalog row with its normalizations precomputed once, so a batch of input
// beers does not re-normalize the whole catalog per beer.
export interface PreparedBeer extends CatalogBeer {
  nameNorm: string;     // normalizeName(name)
  breweryNorm: string;  // normalizeBrewery(brewery)
  aliases: string[];    // breweryAliases(brewery)
  keys: Set<string>;    // nameKeys(name, brewery)  (#117)
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
  // Catalog rows whose brewery aliases match `inputAliases`, via a first-token
  // index instead of a full linear scan. Set-equal to
  // `beers.filter((c) => breweryAliasesMatch(c.aliases, inputAliases))`.
  breweryCandidates(inputAliases: string[]): PreparedBeer[];
  // Catalog rows bucketed under `token` as the first token of one of their brewery
  // aliases. Raw bucket access for the split-invariant second try (#169).
  candidatesByFirstToken(token: string): PreparedBeer[];
  searcherFor(rows: PreparedBeer[]): PreparedSearcher;
  fullSearcher(): PreparedSearcher;
}

// First whitespace-delimited token of a normalized brewery alias. `breweryAliasesMatch`
// reduces to `tokenPrefix`, which requires the shorter token list to be a leading prefix
// of the longer — so two aliases can only match when their first tokens are equal. That
// makes the first token a sound bucket key: matches never span buckets.
function aliasFirstToken(alias: string): string {
  const i = alias.indexOf(' ');
  return i === -1 ? alias : alias.slice(0, i);
}

// Per-row preparation: precompute the normalizations once.
export function prepareBeer(c: CatalogBeer): PreparedBeer {
  return {
    ...c,
    nameNorm: normalizeName(c.name),
    breweryNorm: normalizeBrewery(c.brewery),
    aliases: breweryAliases(c.brewery),
    keys: nameKeys(c.name, c.brewery),
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

  // First-token index: bucket each row under the first token of each of its brewery
  // aliases. Aliases of one row are contiguous, so a tail check dedupes a row that has
  // several aliases sharing a first token. One O(catalog) pass, built eagerly.
  const byFirstToken = new Map<string, PreparedBeer[]>();
  for (const b of beers) {
    for (const alias of b.aliases) {
      const key = aliasFirstToken(alias);
      let bucket = byFirstToken.get(key);
      if (!bucket) byFirstToken.set(key, (bucket = []));
      if (bucket[bucket.length - 1] !== b) bucket.push(b);
    }
  }

  return {
    beers,
    breweryCandidates: (inputAliases) => {
      const seen = new Set<PreparedBeer>();
      const out: PreparedBeer[] = [];
      for (const alias of inputAliases) {
        const bucket = byFirstToken.get(aliasFirstToken(alias));
        if (!bucket) continue;
        for (const c of bucket) {
          if (!seen.has(c) && breweryAliasesMatch(c.aliases, inputAliases)) {
            seen.add(c);
            out.push(c);
          }
        }
      }
      return out;
    },
    candidatesByFirstToken: (token) => byFirstToken.get(token) ?? [],
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

  // One hop of curated-alias expansion (#202): union direct partners, but only
  // when the partnership is non-transitive-safe.
  //   - Simple pairs (each side has exactly 1 partner): both sides expand to each other.
  //   - Hub nodes (>1 partners): hub expands to include all its spokes.
  //   - Spoke nodes (1 partner that itself has >1 partners): spoke does NOT expand to
  //     hub — prevents two spokes from sharing the hub alias and falsely matching.
  //     Exception: typo/rebrand families listed in TRANSITIVE_SAFE_ALIAS_HUBS are safe
  //     to share because every spoke is the same brewery brand.
  // Snapshot aliases first so we iterate only the originally normalized forms.
  for (const a of Array.from(aliases)) {
    const neighbors = aliasNeighbors(a);
    if (neighbors.length > 1) {
      // Hub: expand to all direct spokes.
      for (const n of neighbors) aliases.add(n);
    } else if (neighbors.length === 1) {
      const n = neighbors[0];
      // Only expand if partner is also a leaf (simple pair), not a hub.
      if (aliasNeighbors(n).length === 1 || TRANSITIVE_SAFE_ALIAS_HUBS.has(n)) aliases.add(n);
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

// True if `prefixNorm`'s tokens are a leading, token-boundary prefix of `haystackNorm`.
// One-directional (unlike tokenPrefix): the candidate brewery must appear in full at the
// front of the combined title. Empty operands never match.
export function leadingRun(haystackNorm: string, prefixNorm: string): boolean {
  if (haystackNorm === '' || prefixNorm === '') return false;
  const h = haystackNorm.split(' ');
  const p = prefixNorm.split(' ');
  if (p.length > h.length) return false;
  return p.every((t, i) => t === h[i]);
}

// True if any alias from one side is a token-prefix of any alias from the other.
export function breweryAliasesMatch(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => tokenPrefix(x, y)));
}

// True if the shorter token list appears as a CONTIGUOUS run anywhere within the
// longer. Generalizes tokenPrefix (which requires a *leading* run) to any position.
function tokenSublist(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const ta = a.split(' ');
  const tb = b.split(' ');
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, j) => t === long[i + j])) return true;
  }
  return false;
}

// True if any alias from one side is a contiguous token-sublist of any alias from
// the other (either direction). Looser than breweryAliasesMatch (leading-prefix):
// the RELAXED brewery gate for #120, used only when paired with an exact name match.
// breweryAliasesMatch / tokenPrefix are unchanged.
export function breweryAliasContained(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => tokenSublist(x, y)));
}

// Strip a brewery duplicated into a normalized name (e.g. title "PRIMÁTOR Free Mother
// In Law" with brewery "Primátor", or a trailing "… Trzech Kumpli"). Removes every
// non-overlapping contiguous run of the brewery tokens — at ANY position — but never
// strips the name to empty, then trims any leftover leading/trailing BREWERY_NOISE.
export function stripBreweryFromName(nameNorm: string, breweryNorm: string): string {
  if (!breweryNorm) return nameNorm;
  const bt = breweryNorm.split(' ').filter(Boolean);
  if (!bt.length) return nameNorm;
  const nt = nameNorm.split(' ').filter(Boolean);
  for (let i = 0; i + bt.length <= nt.length; ) {
    if (nt.length - bt.length >= 1 && bt.every((t, j) => nt[i + j] === t)) {
      nt.splice(i, bt.length);
    } else {
      i++;
    }
  }
  while (nt.length > 1 && BREWERY_NOISE.has(nt[0])) nt.shift();
  while (nt.length > 1 && BREWERY_NOISE.has(nt[nt.length - 1])) nt.pop();
  return nt.join(' ');
}

// Order-insensitive canonical form of a normalized string: tokens sorted, re-joined.
function sortedTokens(norm: string): string {
  return norm.split(' ').filter(Boolean).sort().join(' ');
}

// Set of canonical name keys: split on COLLAB_SEP (collab/bilingual sides), normalize
// each side, strip an embedded brewery duplication (anywhere in the name), drop <2-token sides (weak keys), then
// sort tokens (order-insensitive). Names match when their key sets intersect — set
// EQUALITY per side, as FP-safe as exact match. Single-token whole names yield an empty
// set and fall through to the fuzzy path. See spec §3.1.
export function nameKeys(rawName: string, brewery: string): Set<string> {
  const bNorm = normalizeBrewery(brewery);
  const keys = new Set<string>();
  for (const side of rawName.split(COLLAB_SEP)) {
    const toks = stripBreweryFromName(normalizeName(side), bNorm).split(' ').filter(Boolean);
    if (toks.length < 2) continue;
    keys.add([...toks].sort().join(' '));
  }
  return keys;
}

export function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
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
  budget?: FallbackBudget,
): MatchResult | null {
  const inputAliases = breweryAliases(input.brewery);
  const nn = normalizeName(input.name);
  const inputKeys = nameKeys(input.name, input.brewery);   // #117

  // Brewery-matching rows, via the first-token index (was a full O(catalog) scan).
  // Computed once and reused by both the exact filter and the fuzzy pool below.
  const breweryMatches = prepared.breweryCandidates(inputAliases);

  // Exact-normalized hits — multiple rows are common when Untappd has
  // several vintages of the same beer. Latest id first. #117: also accept an
  // order-insensitive / collab-aware name-key intersection as exact-equivalent.
  let exacts = breweryMatches
    .filter((c) => c.nameNorm === nn || intersects(c.keys, inputKeys))
    .sort((a, b) => b.id - a.id);

  // Split-invariant second try (#169): only when the boundary-trusting exact path found
  // nothing. Re-derive the brewery/name cut from the catalog instead of trusting the
  // adapter's split — a candidate matches when its FULL brewery is a leading token-run of
  // the combined title and the remainder equals the candidate's canonical name. Strictly
  // stronger than the normal gate, so accepting single-token names here is FP-safe.
  if (exacts.length === 0) {
    // Normalize the WHOLE `brewery + name` as one string (not each field separately):
    // since the concatenated token sequence is identical no matter where the adapter cut
    // brewery vs name, this makes `combined` split-invariant. Trade-off: a brewery whose
    // name contains a STYLE_WORD (stripped by normalizeName) can't anchor — acceptable, as
    // the target shops' breweries don't, and split-trusting normalization would be worse.
    const combined = normalizeName(`${input.brewery} ${input.name}`);
    const firstToken = combined.split(' ')[0];
    if (firstToken) {
      const anchored = prepared.candidatesByFirstToken(firstToken).filter((cand) =>
        cand.aliases.some((alias) => {
          if (!leadingRun(combined, alias)) return false;
          const remainder = stripBreweryFromName(combined, alias);
          const canonName = stripBreweryFromName(cand.nameNorm, cand.breweryNorm);
          return remainder !== '' && sortedTokens(remainder) === sortedTokens(canonName);
        }),
      );
      if (anchored.length) exacts = anchored.sort((a, b) => b.id - a.id);
    }
  }

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

  // Fuzzy fallback: prefer rows whose brewery aliases overlap the input's, otherwise the
  // full catalog (shared, lazily-built Searcher). The full-catalog path is ~89ms/item over
  // 30k rows (#279); gate it per request so one bad page can't burn ~18s of CPU. Items past
  // the budget return null (stay ⚪). The brewery-bucket path is small/cheap → ungated.
  const pool = breweryMatches;
  const usedFullFallback = pool.length === 0;
  // Use the first alias as the search seed — full normalized brewery already appears at
  // index 0 of breweryAliases when no slash is present.
  const seedBrewery = inputAliases[0] ?? '';
  let searcher: PreparedSearcher; // PreparedSearcher: in-file searcher type
  if (pool.length) {
    searcher = prepared.searcherFor(pool);
  } else {
    if (budget) {
      budget.attempts++;
      if (budget.remaining <= 0) { budget.budgetSkipped++; return null; }
      budget.remaining--;
    }
    searcher = prepared.fullSearcher();
  }
  const results = searcher.search(`${seedBrewery} ${nn}`);
  if (!results.length) return null;
  const best = results[0];
  // Reject a fuzzy candidate that diverges from the input on content tokens — a different
  // flavour variant of the same base beer, which must not inherit drunk/rating data.
  if (nameTokensDiverge(nn, best.item.nameNorm)) return null;
  if (usedFullFallback && budget) budget.hits++;
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
}

// True iff the curated alias layer adds coverage for this brewery, i.e. one of its
// normalized alias forms is a curated alias key. NOTE: `breweryAliases(b).length > 1`
// is the WRONG predicate — plain collaborations ("A / B") also split into multiple
// tokens without any curated pair. This intersection check excludes them.
export function hasCuratedAlias(brewery: string): boolean {
  const keys = aliasKeys();
  return breweryAliases(brewery).some((a) => keys.has(a));
}

// Back-compat single-beer entry point. Prepares the catalog per call, so callers
// that match many beers should call prepareCatalog once and loop matchPrepared.
export function matchBeer(
  input: { brewery: string; name: string; abv?: number | null },
  catalog: CatalogBeer[],
): MatchResult | null {
  return matchPrepared(input, prepareCatalog(catalog));
}
