# Match performance: per-request catalog preparation

**Date:** 2026-06-08
**Status:** Approved (design)
**Scope:** Task 1 (PRIMARY) of the post-extension match-perf follow-ups.

## Problem

`POST /match` is a synchronous (better-sqlite3) handler. For each input beer it calls
`matchBeer(input, catalog)` (`src/domain/matcher.ts`), which **rebuilds all catalog
preparation per beer**:

- The exact-match filter recomputes `breweryAliases(c.brewery)` and `normalizeName(c.name)`
  for every one of the ~20,121 catalog rows, on every input beer.
- The fuzzy pool filter recomputes `breweryAliases(c.brewery)` for every catalog row again.
- When the brewery hard-gate yields an empty pool, it builds a `fast-fuzzy` `Searcher`
  over the **entire catalog** — whose `keySelector` re-normalizes all 20k rows during index
  construction — and does this **per input beer**.

The browser extension sends a whole store grid (24–48 beers) in one `/match` call, so a
single request performs up to ~48 full-catalog Searcher builds plus ~1M normalize calls.

**Measured (prod, read-only, 2026-06-08):** a real 48-beer beerrepublic payload
(`input.json`) took **10,176 ms** (212 ms/beer; 29/48 rows >200 ms — the full-catalog
rebuilds; matched 29/48). Worst case (all-unknown breweries): n=24 → 19 s, n=48 → 37 s.
This is what fires the extension's 10 s fetch timeout, and — because the handler is
synchronous — it freezes the whole Node event loop (Telegram bot included) for the duration.

Same per-beer rebuild also affects the two background-job callers
(`refresh-ontap.ts`, `cleanup-polluted-ontap.ts`), which loop `matchBeer` over a catalog.

## Goal

A 48-beer batch returns in **~1 s** with **identical match results**. The handler stays
synchronous (true non-blocking architecture — worker thread / async-yield — is a separately
queued follow-up). Match correctness is the cardinal constraint: a false "ти це пив" is the
worst possible regression, so the brewery hard-gate (token-prefix) + name-fuzzy semantics
must be byte-for-byte preserved.

## Approach: separate catalog preparation from per-beer matching

Build the expensive, input-independent work **once per request**; reuse it for every beer.

### `src/domain/matcher.ts`

**Prepared catalog row** — normalizations precomputed once:

```ts
interface PreparedBeer extends CatalogBeer {
  nameNorm: string;     // normalizeName(name)
  breweryNorm: string;  // normalizeBrewery(brewery)
  aliases: string[];    // breweryAliases(brewery)
}
```

**Prepared catalog** — prepared rows plus a **lazy, memoized** full-catalog Searcher:

```ts
interface PreparedCatalog {
  beers: PreparedBeer[];
  fullSearcher(): Searcher<PreparedBeer, true>;  // built on first call, then cached
}

export function prepareCatalog(catalog: CatalogBeer[]): PreparedCatalog;
```

The full-catalog Searcher (the single most expensive item — a fuzzy index over 20k rows)
is built **only when the first empty-pool fallback needs it**, and reused thereafter. If no
beer in the batch falls through to the full-catalog fallback, it is never built.

**Per-beer matcher** — the current `matchBeer` body, operating on prepared data:

```ts
export function matchPrepared(
  input: { brewery: string; name: string; abv?: number | null },
  prepared: PreparedCatalog,
): MatchResult | null;
```

Changes vs current `matchBeer`, all mechanical (no logic change):

- exact filter: `c.nameNorm === nn && breweryAliasesMatch(c.aliases, inputAliases)`
- pool filter: `breweryAliasesMatch(c.aliases, inputAliases)`
- Searcher `keySelector` reads precomputed `c.breweryNorm` / `c.nameNorm`
- empty pool → `prepared.fullSearcher()` (shared); non-empty pool → small per-beer
  `Searcher` over the pool (cheap; pool is one brewery's beers)

The matching logic itself — brewery hard-gate, exact path, year/ABV resolution
(`extractYear`, `ABV_TOLERANCE`), `FUZZY_THRESHOLD = 0.75`, "latest id first", "do not
cross-match vintages" — is copied verbatim.

**Backward-compatible wrapper:**

```ts
export function matchBeer(input, catalog: CatalogBeer[]): MatchResult | null {
  return matchPrepared(input, prepareCatalog(catalog));
}
```

Existing tests and any caller left on `matchBeer` keep working with zero behavior change
(they just don't get the batch speedup).

### Integration

- **`src/domain/match-list.ts` (PRIMARY):** `matchBeerList` calls `prepareCatalog(catalog)`
  once, then maps `matchPrepared` over the input beers. This is the `/match` fix.
- **`src/jobs/refresh-ontap.ts` and `src/jobs/cleanup-polluted-ontap.ts`:** hoist
  `prepareCatalog` out of the per-beer loop and switch the loop body to `matchPrepared`.
  Same bug, same two-line change per job. Included in this PR.

## Error handling

No new failure modes. `prepareCatalog` is pure CPU work over an in-memory array; an empty
catalog yields an empty prepared catalog and `matchPrepared` returns `null` (current
behavior). The lazy `fullSearcher` over an empty catalog returns no results → `null`.

## Testing

**Correctness (CI — the regression guard):**
- All existing `matcher.test.ts` / `match-list.test.ts` cases pass **unchanged** — they
  already pin exact expected outputs across exact/fuzzy/year/ABV/collab paths.
- New test: **prepare-once == prepare-per-beer.** For a heterogeneous set of input beers,
  `matchBeerList` (prepare-once) returns the same per-item result as calling `matchBeer`
  (prepare-per-call) on each item individually. This directly proves the optimization does
  not move any match.
- New test: **lazy `fullSearcher`.** It is built only when an empty-pool fallback occurs;
  a batch whose every beer matches exactly never triggers a full-catalog index build.

**Benchmark (manual, not CI — needs prod DB):**
- `scripts/bench-match.ts`: opens the prod DB read-only, `loadCatalog`, runs
  `matchBeerList` over `input.json` (slice the file to its last `}` to drop the stray
  trailing `1`), prints total ms, ms/beer, and matched count. Run before/after; expect
  ~10 s → ~1 s with an **identical matched count**.

## spec.md

The public `/match` contract and the match results are unchanged, so `spec.md` likely needs
no edit. Review it during implementation; if any documented behavior/performance note is
affected, update it in the same PR (per CLAUDE.md).

## Out of scope (separately queued)

- **Non-blocking `/match` architecture** (worker thread or async-yield so the event loop is
  not blocked even for ~1 s) — queued as a follow-up *after* the extension chunking stopgap.
- **Cross-request catalog/Searcher caching** — rejected as premature (single-user, infrequent
  requests); per-request preparation meets the ~1 s goal without invalidation complexity.
