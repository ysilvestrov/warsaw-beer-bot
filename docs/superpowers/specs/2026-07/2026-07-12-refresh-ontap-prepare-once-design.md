# Design: prepare the ontap catalog once per run + incremental add (#278)

## Problem

`refreshOntap` (`src/jobs/refresh-ontap.ts`) rebuilds the entire prepared catalog
**inside the per-pub loop** (`:95-96`):

```ts
const catalog = listBeerCatalog(db);      // full beers scan
const prepared = prepareCatalog(catalog); // re-normalize all ~30k rows, synchronous
```

Unlike the `/match` path (`matchBeerList` / `prepareCatalogChunked`), this is the plain
**synchronous** `prepareCatalog` — no cooperative yielding. Prod numbers (2026-07-11):
30,869 beers × ~1.2 s prepare × **114 pubs** ≈ **2.5 minutes of cumulative event-loop
blocking per run**, delivered as ~1.3 s uninterruptible chunks. Runs every 12 h plus every
manual `/refresh`. During each chunk nothing else runs — `/match`, `/enrich`,
`/checkins/sync`, and all Telegram updates stall behind it. With ~10 users active during the
refresh window, latencies compound.

The per-pub rebuild exists because matching may `upsertBeer` a fresh orphan (`:109`) that
**later pubs in the same run must see** (to match against it instead of inserting a
duplicate).

A smaller instance of the same pattern is `cleanupPollutedOntap`
(`src/jobs/cleanup-polluted-ontap.ts:52`): a single synchronous `prepareCatalog(pool)` at
startup — one ~1.2 s block, only when polluted beers exist. Low impact, but the same rule
("no synchronous full prepare in the ontap jobs") should apply.

## Goal

Prepare the catalog **once per run**, then keep it current by **incrementally adding** each
fresh orphan row — removing the 114× rebuild while preserving the "later pubs see earlier
orphans" behavior. Use the chunked, yielding prepare for the one-time build so even that cost
doesn't block.

### Decisions taken during brainstorming

- **Own a per-run copy, do NOT reuse the shared #277 cache.** Mutating the shared
  `PreparedCatalog` instance would race concurrent `/match` reads, and the cache's own
  version-triggered background rebuild would replace the instance mid-run and silently drop
  the incremental adds. The shared cache does **not** need feeding: `upsertBeer` already bumps
  `catalogVersion` (`src/storage/beers.ts`), so `/match` self-heals via its normal SWR
  rebuild. The two concerns are cleanly separable. The per-run copy is built through the
  shared `prepareCatalogChunked` helper (DRY, non-blocking).
- **`add(row)` touches only `beers` + the `byFirstToken` index; the memoized `full` searcher
  is left as-is.** A fresh orphan is reachable by later taps through: the exact/key path
  (reads `byFirstToken`) and the brewery-bucket fuzzy path (`searcherFor(pool)`, rebuilt fresh
  per call from `breweryCandidates`). The full-catalog fuzzy path (`fullSearcher()`) only
  fires for taps whose brewery has **no bucket** — a fresh orphan, by definition, now *has* a
  bucket, so later taps from that brewery never route through the full path. Therefore the
  full index never needs same-run orphans, and *not* invalidating it avoids re-triggering the
  ~0.62 s full-index rebuild repeatedly during a run (which eager invalidation would do,
  reintroducing the very stalls we are removing).

Out of scope (separate issues): `worker_threads` (#84); the shared process-level cache itself
(#277, already shipped).

## Design

### 1. `PreparedCatalog.add(row)` — `src/domain/matcher.ts`

Add one method to the `PreparedCatalog` interface (`:46-57`) and its implementation in
`makePreparedCatalog` (`:82-122`):

```ts
export interface PreparedCatalog {
  // ...existing...
  // Append a single already-prepared row: push to `beers` and index it under the first token
  // of each of its brewery aliases. Does NOT rebuild the memoized fullSearcher — see #278.
  add(row: PreparedBeer): void;
}
```

Extract the existing per-row indexing (`:92-99`, the `for (const alias of b.aliases)` bucket
insert with the tail-check dedupe `if (bucket[bucket.length - 1] !== b) bucket.push(b)`) into a
private helper `indexRow(b: PreparedBeer)` used by **both** the initial build loop and `add()`
— identical dedupe semantics, no duplication. `add()`:

```ts
add: (row) => { beers.push(row); indexRow(row); },
```

`full` (the lazily-built, memoized full-catalog `Searcher`) is intentionally untouched.

### 2. `prepareCatalogChunked` param widening — `src/domain/catalog-cache.ts`

Change the parameter type from `CatalogBeerWithRating[]` → `CatalogBeer[]` (`:36-39`). The
function only calls `prepareBeer`, which needs just `CatalogBeer`. `CatalogBeerWithRating`
extends `CatalogBeer`, so the existing cache callers still satisfy it. This lets `refreshOntap`
reuse the helper on plain catalog rows without fabricating `rating_global`/`untappd_id`.

### 3. `refreshOntap` — `src/jobs/refresh-ontap.ts`

- Add an optional DI seam to `Deps`, mirroring the existing `now?` / `breaker?` test seams:
  ```ts
  prepareCatalog?: (rows: CatalogBeer[]) => Promise<PreparedCatalog>;  // default: prepareCatalogChunked
  ```
- **Build once**, before the city loop:
  ```ts
  const prepared = await prepareCatalog(listBeerCatalog(db));
  ```
- **Delete** the in-loop `listBeerCatalog(db)` + `prepareCatalog(catalog)` (`:95-96`). The tap
  loop matches against the shared `prepared`.
- On a **fresh orphan** insert (`:108-119`), immediately add it to the in-memory catalog so
  later pubs match rather than re-insert:
  ```ts
  beerId = upsertBeer(db, { /* ...unchanged... */ });
  prepared.add(prepareBeer({ id: beerId, brewery, name, abv: t.abv }));
  upsertMatch(db, t.beer_ref, beerId, 1.0);
  isFreshOrphan = true;
  ```
  (`prepareBeer` is already exported from `matcher.ts`.)

The existing `listBeerCatalog` helper stays (now called once). Import `prepareBeer` and the
`CatalogBeer`/`PreparedCatalog` types; drop the now-unused `prepareCatalog` import.

### 4. `cleanupPollutedOntap` light touch — `src/jobs/cleanup-polluted-ontap.ts` + `src/index.ts`

- Swap `const preparedPool = prepareCatalog(pool)` → `const preparedPool = await prepareCatalogChunked(pool)`.
- Make `cleanupPollutedOntap` `async` → returns `Promise<CleanupResult>`. Import
  `prepareCatalogChunked` from `../domain/catalog-cache`; drop the `prepareCatalog` import.
- Update the single call site `src/index.ts:61` (`cleanupPollutedOntap(db, log);`) — it runs
  inside `async function main()`, so change it to `await cleanupPollutedOntap(db, log);`. (No
  incremental-add here — this job does not `upsertBeer` during its match loop.)

## Testing (Vitest, TDD)

- **`matcher.test.ts`** — `add(row)`:
  - After `add`, the row appears in `breweryCandidates(itsAliases)` and
    `candidatesByFirstToken(firstToken)`, and `matchPrepared` exact-matches an input equal to it.
  - The memoized `full` searcher is **not** rebuilt by `add()`: with an injected build spy,
    the build-call count is identical before and after an `add()` (and a subsequent
    empty-pool fallback still builds at most once, over the pre-add row set).
  - A multi-alias row (e.g. a collab `"A / B"`) is bucketed under each alias's first token and
    de-duplicated (not double-pushed) — same invariant as the initial build.
- **`refresh-ontap.test.ts`**:
  - Two pubs whose pages reference the **same** not-in-catalog beer → exactly **one** `beers`
    row; the second pub produces a `match_links` row pointing at the first pub's orphan
    (cross-pub incremental-add reuse), not a duplicate insert.
  - The catalog is prepared **once per run**: inject the `prepareCatalog` DI seam as a spy and
    assert it is called exactly once regardless of pub count.
- **`cleanup-polluted-ontap.test.ts`**: existing assertions still pass with the async/chunked
  prepare (update call sites to `await`).

## Spec + docs

- `spec.md`: extend the "Багатомісто (#146)" `refreshOntap` section (~:919) with a note that
  the catalog is prepared **once per run** via the chunked yielding build and kept current by
  incrementally adding each fresh orphan (`PreparedCatalog.add`), replacing the former
  per-pub rebuild (#278); and note `cleanupPollutedOntap` uses the same chunked prepare.
- No extension impact → no `docs/extension-install-uk.md` change.

## Related

#277 (shared cache — self-invalidates via `catalogVersion`, not fed by this job), #84
(worker_threads), #279 (fuzzy budget — the `/match` path; refresh matching stays ungated).
