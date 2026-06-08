# Non-blocking /match: cooperative event-loop yielding

**Date:** 2026-06-08
**Status:** Approved (design)
**Scope:** Task 3 of the post-extension match-perf follow-ups (option A). Option B
(worker_threads, true off-thread matching) is deferred — tracked as GitHub issue **#84**.

## Problem

The Telegram bot (`bot.launch()`) and the Hono API server (`createApiServer`) run in
the **same Node process / event loop** (`src/index.ts`). `POST /match` is fully
synchronous, so for its whole duration the event loop is blocked and the bot freezes
(long-poll updates are not processed).

After PR #83 (per-request `prepareCatalog`), a real 48-beer batch is ~2 s instead of
~10 s, but it still blocks. Measured split on the prod catalog (20,120 rows, read-only):

```
loadCatalog = 60 ms    prepareCatalog = 541 ms    matchLoop = 1574 ms (48 beers)
per-beer: top5 = 66,51,46,44,44 ms   median = 37 ms
```

Two things matter:
- **`prepareCatalog` is a single ~541 ms CPU block** (normalizing 20k rows). Yielding only
  between beers would leave a ~half-second freeze at the start.
- The **per-beer** blocks are now small (≤66 ms) — the full-catalog `Searcher` is built once
  (lazily) and reused, not rebuilt per beer. So yielding between beers caps blocks at ~66 ms.

## Goal

`POST /match` no longer freezes the bot. No single synchronous block exceeds ~tens of ms
beyond an atomic DB read. Wall-clock latency stays ~2 s (we interleave, not parallelize —
parallelism is issue #84). Match results stay byte-for-byte identical (the cardinal
constraint: a false "ти це пив" is the worst bug).

Non-goal: reducing `/match` latency or running matching on another thread (issue #84).

## Approach: yield the event loop in the two CPU-heavy places

Insert cooperative `await setImmediate`-based yields (a) between chunks of catalog
preparation and (b) between input beers in the match loop. Between yields the long-poll
bot processes its updates, so it stays responsive (worst added latency ≈ one block, ≤~66 ms).

### `src/domain/matcher.ts` — stays synchronous and pure (the matching kernel)

Refactor only to expose reusable building blocks; no async enters this module:

```ts
export function prepareBeer(c: CatalogBeer): PreparedBeer;          // per-row norm/aliases
export function makePreparedCatalog(
  beers: PreparedBeer[],
  build?: (rows: PreparedBeer[]) => PreparedSearcher,
): PreparedCatalog;                                                  // assembles lazy fullSearcher
```

`prepareCatalog(catalog, build?)` becomes `makePreparedCatalog(catalog.map(prepareBeer), build)`
— **identical signature and behavior**. The two job callers and the `matchBeer` back-compat
wrapper are untouched; `matchPrepared` is unchanged.

### `src/domain/match-list.ts` — all async / yielding orchestration lives here

```ts
const PREP_CHUNK = 2000;  // ≈ ≤60 ms of normalization per chunk at ~0.027 ms/row

export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// Builds PreparedBeer[] in chunks, yielding between chunks, then assembles the catalog.
async function prepareCatalogChunked(
  catalog: CatalogBeerWithRating[],
  yield_: () => Promise<void>,
): Promise<PreparedCatalog> {
  const beers: PreparedBeer[] = [];
  for (let i = 0; i < catalog.length; i += PREP_CHUNK) {
    const end = Math.min(i + PREP_CHUNK, catalog.length);
    for (let j = i; j < end; j++) beers.push(prepareBeer(catalog[j]));
    await yield_();
  }
  return makePreparedCatalog(beers);
}

export interface MatchListOptions {
  yield?: () => Promise<void>;  // DI seam for deterministic yield-count tests
}

export async function matchBeerList(
  catalog: CatalogBeerWithRating[],
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: MatchInput[],
  opts: MatchListOptions = {},
): Promise<MatchListResult[]> {
  const yield_ = opts.yield ?? yieldToEventLoop;
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const prepared = await prepareCatalogChunked(catalog, yield_);
  const out: MatchListResult[] = [];
  for (const item of items) {
    const raw = { brewery: item.brewery, name: item.name };
    const m = matchPrepared(item, prepared);
    if (!m) {
      out.push({ raw, matched_beer: null, is_drunk: false, user_rating: null });
    } else {
      const beer = byId.get(m.id)!;
      out.push({
        raw,
        matched_beer: { id: beer.id, name: beer.name, brewery: beer.brewery, rating_global: beer.rating_global },
        is_drunk: drunkSet.has(m.id),
        user_rating: ratingByBeerId.get(m.id) ?? null,
      });
    }
    await yield_();
  }
  return out;
}
```

`matchBeerList` becomes async; the synchronous version is dropped (the route is its only
production caller). The pure synchronous matching kernel (`matchPrepared` / `prepareCatalog`)
remains in `matcher.ts`, fully covered by sync tests.

### `src/api/routes/match.ts`

The handler becomes `async` and `await`s `matchBeerList`. `loadCatalog`, `triedBeerIds`,
`latestRatingsByBeer` stay synchronous at the top (atomic DB reads, ~60–80 ms total).

## Error handling

`yieldToEventLoop` cannot reject. The matching logic is unchanged, so no new failure modes.
Hono's existing `app.onError` already turns a thrown handler error into a `500`; awaiting an
async handler preserves that.

## Testing

**Correctness (CI):**
- Every existing `match-list.test.ts` case is updated to `await matchBeerList(...)` and must
  pass unchanged in its assertions.
- The Task-1 "prepare-once equivalence" test (`matchBeerList` vs per-beer `matchBeer`) stays
  valid (now awaited) — proves yielding/chunking moves no match.
- `matcher.test.ts` (sync kernel) is unaffected.

**Yielding (CI, deterministic via DI):**
- With an injected `opts.yield` spy and a catalog larger than `PREP_CHUNK` (e.g. 2001 synthetic
  rows) plus N input beers, assert the spy was called at least `ceil(catalog.length / PREP_CHUNK)
  + N` times (prep-chunk yields + per-beer yields).
- A small-catalog case asserts at least `1 + N` yields (one prep chunk + per beer).

**Manual (not CI):** existing `scripts/bench-match.ts` — make its caller `await` the now-async
`matchBeerList`; confirm matched count and ~2 s wall-clock are unchanged (yielding adds only
negligible `setImmediate` overhead).

## spec.md

`spec.md §5` documents intentional invariants; §3.3 currently scopes "external I/O timeout" to
outbound network and notes "synchronous better-sqlite3 calls are not external I/O". The change
keeps the public `/match` contract and results identical, so no contract edit is required.
Review §5/§3.3 during implementation; if a note about `/match` being synchronous needs
updating (it now yields cooperatively), update it in the same PR (per CLAUDE.md).

## Out of scope
- **Worker-thread / true off-thread matching** — GitHub issue **#84**.
- **Cross-request catalog caching** — rejected in PR #83 (premature for single-user load).
