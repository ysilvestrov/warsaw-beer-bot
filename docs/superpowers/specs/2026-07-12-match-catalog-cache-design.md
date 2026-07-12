# Design: shared `PreparedCatalog` cache for `/match` (#277)

## Problem

`POST /match` (`src/api/routes/match.ts`) rebuilds everything from scratch on **every**
request against the prod catalog (30,869 beers, 2026-07-11):

1. `loadCatalog(db)` — full `beers` scan, synchronous `better-sqlite3` (~85 ms, blocks the
   event loop).
2. `matchBeerList` → `prepareCatalogChunked` — re-normalizes the entire catalog per request
   (~1,190 ms CPU).
3. `fullSearcher()` — the fast-fuzzy index is memoized **per request only**, so any request
   with one unmatched beer rebuilds it (~620 ms CPU).

A 50-item mixed request ≈ **3.9 s CPU** and holds **~150 MB RSS** while in flight. All of it
runs in the single bot process on one core; with ~10 concurrent extension users the requests
serialize (20–40 s tail latency) and in-flight `PreparedCatalog`s stack at ~150 MB each — an
OOM spiral under sustained load. The per-request prepare was a deliberate single-user choice
in #83; CWS publication will bring simultaneous users.

## Goal

Cache one shared `PreparedCatalog` (+ its `byId` map and memoized `fullSearcher`) at process
level, invalidated precisely on catalog writes. Warm-cache `/match` cost drops from ~2–4 s CPU
+ ~150 MB per request to ~1 ms/exact item with near-zero allocation. Per-user drunk/rating
data stays per-request.

Out of scope (separate issues): the fuzzy per-input `searcherFor(pool)` build (#279),
`refreshOntap`'s in-loop rebuild (#278), `worker_threads` (#84).

## Decisions

- **Invalidation signal: an in-process monotonic counter**, not `PRAGMA data_version`.
  `data_version` only bumps for commits from *other* connections — by SQLite's contract it
  does **not** change for writes on the connection that reads it. The bot writes and reads
  through one shared `better-sqlite3` connection, so `data_version` would never move on our
  own writes and the cache would serve stale results until TTL. The counter is precise: the
  next `/match` after any write rebuilds.
- **SWR (stale-while-revalidate)** on staleness, single-flight rebuild. `/match` latency stays
  flat even right after a write; a just-written beer is at most ~2 s late to appear.
- **5-minute TTL backstop**: rebuild when the cache is older than the TTL even if the counter
  has not moved — cheap insurance against a write path we forget to instrument.
- **Lazy warmup**: build on first `/match`, not at process startup. The only cost is the first
  request after a restart pays the ~1.9 s build.

## Components

### 1. `src/storage/catalog-version.ts` — the invalidation signal

A tiny module holding a module-level integer:

```ts
let version = 0;
export function catalogVersion(): number { return version; }
export function bumpCatalogVersion(): void { version++; }
```

Single-threaded JS + one sqlite connection ⇒ a plain number is race-free. Kept in its own
module (not `beers.ts`) so both the storage writers and the domain cache import it without a
cycle.

### 2. Instrument the write paths (`src/storage/beers.ts`)

Call `bumpCatalogVersion()` at the end of the mutators that change a **matchable** field
(`brewery` / `name` / `abv` / `rating_global` / `untappd_id`, or row existence):

- `upsertBeer` (both the UPDATE and INSERT branches)
- `recordLookupSuccess`
- `mergeIntoCanonical`
- `recordRatingSuccess`

**Not** bumped (timestamp/counter-only, never affect `/match` output):
`recordLookupNotFound`, `recordLookupTransient`, `recordRatingNotFound`,
`recordRatingTransient`.

Most catalog writes funnel through these functions, so the enrich route, checkins route,
refresh-ontap, and import get covered transitively. A few cron/maintenance jobs write matchable
`beers` fields with **raw SQL** that bypasses the mutators — these bump `bumpCatalogVersion()`
directly at their write site:

- `refresh-untappd.ts` — `updateRatingAndAbv` (rating_global/abv on an existing row).
- `cleanup-polluted-ontap.ts` — the rewrite/merge transaction (name/normalized_name + DELETE).
- `dedupe-brewery-aliases.ts` — the merge transaction (DELETE orphan rows).

Deliberately **not** instrumented: `backfill-normalized-brewery.ts` (writes only the
`normalized_brewery` column, which the prepared catalog recomputes from raw `brewery` — no
`/match` effect) and the `schema.ts` re-arm migration (lookup counters only). The 5-minute TTL
backstop (§3) covers any write path still missed.

### 3. `src/domain/catalog-cache.ts` — the cache

```ts
export interface CachedCatalog {
  prepared: PreparedCatalog;
  byId: Map<number, CatalogBeerWithRating>;
}
export function createCatalogCache(db: DB, opts?: {
  getVersion?: () => number;                       // default: catalogVersion
  load?: () => CatalogBeerWithRating[];            // default: () => loadCatalog(db)
  prepare?: (rows) => Promise<PreparedCatalog>;    // default: prepareCatalogChunked
  now?: () => number;                              // default: Date.now
  ttlMs?: number;                                  // default: 5 * 60_000
}): { get(): Promise<CachedCatalog> };
```

Internal state: `current: { value: CachedCatalog; version: number; builtAt: number } | null`
and `rebuilding: Promise<void> | null` (single-flight guard).

`get()`:
- **Cold** (`current === null`): `await rebuild()`, return `current.value` (lazy warmup, once
  per process).
- **Warm**: return `current.value` immediately. If stale — `current.version !== getVersion()`
  **or** `now() - current.builtAt > ttlMs` — **and** `rebuilding === null`, launch
  `rebuild()` in the background (not awaited). That is SWR.

`rebuild()`:
1. `const v = getVersion()` **before** `load()` — so a write landing mid-rebuild leaves
   `current.version < getVersion()` and the next `get()` re-triggers (no lost update).
2. `const rows = load()`; `const prepared = await prepare(rows)`;
   `const byId = new Map(rows.map(r => [r.id, r]))`.
3. `current = { value: { prepared, byId }, version: v, builtAt: now() }`.
4. Wrapped so `rebuilding` is set on entry and cleared in `finally`; concurrent `get()` calls
   reuse the in-flight promise instead of starting a second build.

### 4. Wire into the route (`src/api/routes/match.ts`, `src/domain/match-list.ts`)

`matchRoute` constructs one `createCatalogCache(deps.db)` at registration time (closured over
the route, single instance). Per request:

```ts
const { prepared, byId } = await cache.get();
const results = await matchBeerList(prepared, byId, drunkSet, ratings, beers);
```

`matchBeerList` loses its prepare step — new signature
`matchBeerList(prepared, byId, drunkSet, ratingByBeerId, items, opts?)` — and keeps the
per-item `matchPrepared` loop plus its cheap `yieldToEventLoop`. `drunkSet` / `ratings` stay
per-request (per-user, cheap). `prepareCatalogChunked` moves to (or is shared with) the cache
module. `matchBeer` / `prepareCatalog` in `matcher.ts` stay for the other callers/tests.

## Data flow per request (warm cache)

`cache.get()` returns the shared `{ prepared, byId }` in O(1) → loop `matchPrepared` (~1 ms per
exact item) + per-user drunk/rating lookups → respond. No catalog scan, no normalization, no
searcher build.

## Trade-offs / edges

- **Steady memory** ~150 MB resident (one catalog held permanently) — the intended trade.
  During a rebuild we transiently hold two catalogs (old `current` + the one being built)
  ≈ 300 MB peak, bounded at 2× by single-flight.
- A just-written beer can be ~2 s late to appear (SWR window + rebuild time). Acceptable for
  the enrich/badge flow.
- First `/match` after a restart pays the ~1.9 s build (lazy warmup).
- `loadCatalog` stays synchronous — it blocks the event loop for ~85 ms per rebuild (once per
  catalog change or TTL, not per request). Acceptable.

## Testing

- **`catalog-version`**: `bumpCatalogVersion` increments; matchable mutators bump and
  timestamp-only mutators don't (in-memory DB integration test).
- **`catalog-cache`**: cold build; reuse across gets (prepare called once); version bump →
  background rebuild → flips to fresh value; TTL backstop triggers a rebuild with an unchanged
  version; single-flight under concurrent `get()` (prepare called once); mid-rebuild bump
  leaves the result stale so the next `get()` re-triggers. Inject `getVersion` / `load` /
  `prepare` / `now`.
- **`match` route / `matchBeerList`**: correct results with the new signature (regression
  against current behavior); catalog prepared once across two sequential requests.

## Spec impact

The `/match` request/response contract is unchanged, so `spec.md` §`POST /match` needs only a
short **eventual-consistency** note: results are served from a process-level catalog cache
invalidated on catalog writes, so a just-written beer may take up to ~2 s (plus one request) to
appear. Add it in the same PR per `CLAUDE.md`. No extension-facing change → no
`docs/extension-install-uk.md` update.
