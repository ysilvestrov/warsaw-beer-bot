# Shared PreparedCatalog Cache for /match — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache one shared `PreparedCatalog` (+ its `byId` map and memoized fuzzy searcher) at process level, invalidated by an in-process monotonic counter, so `POST /match` stops rebuilding the whole 30k-beer catalog on every request.

**Architecture:** A module-level integer (`catalog-version`) is bumped by the storage mutators that change matchable fields. A `catalog-cache` module builds the `PreparedCatalog` lazily and serves it stale-while-revalidate: warm requests get the shared catalog in O(1); on a version bump or TTL expiry it rebuilds once in the background (single-flight). The `/match` route holds one cache instance; `matchBeerList` drops its per-request prepare step and takes the prepared catalog directly.

**Tech Stack:** Node.js, TypeScript, better-sqlite3 (synchronous, single connection), Hono, fast-fuzzy, Vitest.

**Design doc:** `docs/superpowers/specs/2026-07-12-match-catalog-cache-design.md`

**Worktree guard (for subagents):** Every task runs inside the feature worktree. Before committing, run `git rev-parse --show-toplevel` and `git branch --show-current` and confirm you are on the feature branch inside the worktree, NOT the main checkout at `/home/ysi/warsaw-beer-bot`.

---

## File Structure

- **Create** `src/storage/catalog-version.ts` — the monotonic invalidation counter (module-level int + getter + bump).
- **Modify** `src/storage/beers.ts` — call `bumpCatalogVersion()` in the four matchable-field mutators.
- **Create** `src/storage/catalog-version.test.ts` — counter unit + storage-integration bump coverage.
- **Create** `src/domain/catalog-cache.ts` — `createCatalogCache(db, opts?)` (SWR + single-flight) and the moved `prepareCatalogChunked`.
- **Create** `src/domain/catalog-cache.test.ts` — cold build, reuse, version-bump SWR, TTL, single-flight, mid-rebuild re-trigger, chunk-yielding.
- **Modify** `src/domain/match-list.ts` — new `matchBeerList(prepared, byId, …)` signature; remove the internal prepare; keep `yieldToEventLoop`.
- **Modify** `src/domain/match-list.test.ts` — adapt calls to the new signature; move the chunk-yield assertion out.
- **Modify** `src/api/routes/match.ts` — construct one cache; `await cache.get()` per request.
- **Modify** `spec.md` — eventual-consistency note in the `POST /match` section.

---

## Task 1: catalog-version counter

**Files:**
- Create: `src/storage/catalog-version.ts`
- Test: `src/storage/catalog-version.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/storage/catalog-version.test.ts
import { catalogVersion, bumpCatalogVersion } from './catalog-version';

describe('catalog-version', () => {
  it('bumpCatalogVersion increments the version', () => {
    const before = catalogVersion();
    bumpCatalogVersion();
    expect(catalogVersion()).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/catalog-version.test.ts`
Expected: FAIL — cannot find module `./catalog-version`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/storage/catalog-version.ts

// Process-level monotonic counter, bumped by the storage mutators that change a
// matchable beer field (see beers.ts). The /match catalog cache reads it to decide
// when to rebuild. Single-threaded JS + one better-sqlite3 connection ⇒ a plain
// number is race-free. Deliberately NOT PRAGMA data_version: that only reflects
// commits from OTHER connections, so it never moves on our own single-connection writes.
let version = 0;

export function catalogVersion(): number {
  return version;
}

export function bumpCatalogVersion(): void {
  version++;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/catalog-version.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/catalog-version.ts src/storage/catalog-version.test.ts
git commit -m "feat(match): add catalog-version invalidation counter (#277)"
```

---

## Task 2: instrument the storage write paths

**Files:**
- Modify: `src/storage/beers.ts`
- Test: `src/storage/catalog-version.test.ts` (add cases)

- [ ] **Step 1: Write the failing test (append to the existing file)**

```ts
// append to src/storage/catalog-version.test.ts
import { openDb } from './db';
import { migrate } from './schema';
import {
  upsertBeer,
  recordLookupSuccess,
  recordRatingSuccess,
  recordLookupNotFound,
  recordRatingNotFound,
} from './beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';

function seedBeer(db: ReturnType<typeof openDb>) {
  return upsertBeer(db, {
    name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA', abv: 6.1, rating_global: 3.7,
    normalized_name: normalizeName('Atak Chmielu'),
    normalized_brewery: normalizeBrewery('Pinta'),
  });
}

describe('catalog-version — storage instrumentation', () => {
  it('bumps on matchable-field mutators', () => {
    const db = openDb(':memory:');
    migrate(db);

    let v = catalogVersion();
    const id = seedBeer(db);           // upsertBeer (insert)
    expect(catalogVersion()).toBeGreaterThan(v);

    v = catalogVersion();
    upsertBeer(db, {                   // upsertBeer (update — same normalized keys)
      name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA', abv: 6.2, rating_global: 3.8,
      normalized_name: normalizeName('Atak Chmielu'),
      normalized_brewery: normalizeBrewery('Pinta'),
    });
    expect(catalogVersion()).toBeGreaterThan(v);

    v = catalogVersion();
    recordLookupSuccess(db, id, { bid: 111, style: 'IPA', abv: 6.1, global_rating: 3.9 }, '2026-01-01T00:00:00Z');
    expect(catalogVersion()).toBeGreaterThan(v);

    v = catalogVersion();
    recordRatingSuccess(db, id, 4.1);
    expect(catalogVersion()).toBeGreaterThan(v);
  });

  it('does NOT bump on timestamp/counter-only mutators', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = seedBeer(db);

    const v = catalogVersion();
    recordLookupNotFound(db, id, '2026-01-01T00:00:00Z');
    recordRatingNotFound(db, id, '2026-01-01T00:00:00Z');
    expect(catalogVersion()).toBe(v);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/catalog-version.test.ts`
Expected: FAIL — the first describe still passes, but "storage instrumentation" fails because no mutator bumps yet.

- [ ] **Step 3: Implement — add the bump import and four calls in `src/storage/beers.ts`**

At the top of the file, after the existing `import type { DB } from './db';` line, add:

```ts
import { bumpCatalogVersion } from './catalog-version';
```

In `upsertBeer`, add `bumpCatalogVersion();` immediately before **each** of the two returns. The UPDATE branch:

```ts
  if (existing) {
    db.prepare(
      `UPDATE beers SET untappd_id = COALESCE(?, untappd_id), name = ?, brewery = ?,
         style = ?, abv = ?, rating_global = ?,
         normalized_name = ?, normalized_brewery = ? WHERE id = ?`,
    ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null,
          b.abv ?? null, b.rating_global ?? null,
          b.normalized_name, b.normalized_brewery, existing.id);
    bumpCatalogVersion();
    return existing.id;
  }
```

The INSERT branch:

```ts
  const res = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
       normalized_name, normalized_brewery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null, b.abv ?? null,
        b.rating_global ?? null, b.normalized_name, b.normalized_brewery);
  bumpCatalogVersion();
  return Number(res.lastInsertRowid);
```

In `recordLookupSuccess`, add `bumpCatalogVersion();` after the `.run(...)` call (end of the function body).

In `mergeIntoCanonical`, add `bumpCatalogVersion();` after the `DELETE FROM beers` statement (end of the function body):

```ts
export function mergeIntoCanonical(db: DB, orphanId: number, canonicalId: number): void {
  db.prepare('UPDATE match_links SET untappd_beer_id = ? WHERE untappd_beer_id = ?')
    .run(canonicalId, orphanId);
  db.prepare('DELETE FROM beers WHERE id = ?').run(orphanId);
  bumpCatalogVersion();
}
```

In `recordRatingSuccess`, add `bumpCatalogVersion();` after the `.run(...)` call (end of the function body).

Do **not** touch `recordLookupNotFound`, `recordLookupTransient`, `recordRatingNotFound`, `recordRatingTransient` — they change only lookup timestamps/counters, never a `/match` output field.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/catalog-version.test.ts`
Expected: PASS (both describes).

- [ ] **Step 5: Commit**

```bash
git add src/storage/beers.ts src/storage/catalog-version.test.ts
git commit -m "feat(match): bump catalog-version on matchable beer writes (#277)"
```

---

## Task 3: catalog-cache module

**Files:**
- Create: `src/domain/catalog-cache.ts`
- Test: `src/domain/catalog-cache.test.ts`

Note: this task's tests inject `getVersion`/`load`/`prepare`/`now` so they never touch the global counter or a real DB — fully hermetic.

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/catalog-cache.test.ts
import { vi } from 'vitest';
import { createCatalogCache, prepareCatalogChunked, type CatalogCache } from './catalog-cache';
import type { CatalogBeerWithRating } from './match-list';
import type { DB } from '../storage/db';

const rows: CatalogBeerWithRating[] = [
  { id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7, untappd_id: 111 },
  { id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta', abv: 5.0, rating_global: 3.5, untappd_id: null },
];

// A deferred promise so tests can control when a rebuild's prepare resolves.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Minimal cache under test with injected seams. `db` is never touched (load is injected).
function make(opts: Parameters<typeof createCatalogCache>[1]): CatalogCache {
  return createCatalogCache({} as DB, opts);
}

describe('createCatalogCache', () => {
  it('cold get builds once and returns the prepared catalog + byId', async () => {
    const load = vi.fn(() => rows);
    const cache = make({ getVersion: () => 0, load });
    const { prepared, byId } = await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    expect(prepared.beers.length).toBe(2);
    expect(byId.get(1)?.name).toBe('Atak Chmielu');
  });

  it('warm get reuses the cache — no second load while version is unchanged', async () => {
    const load = vi.fn(() => rows);
    const cache = make({ getVersion: () => 0, load });
    await cache.get();
    await cache.get();
    await cache.idle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves stale then rebuilds in the background after a version bump (SWR)', async () => {
    let version = 0;
    const load = vi.fn(() => rows);
    const cache = make({ getVersion: () => version, load });
    await cache.get();               // cold build at version 0
    version = 1;                     // catalog changed
    await cache.get();               // returns stale immediately, triggers bg rebuild
    await cache.idle();              // wait for the background rebuild
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent cold gets — prepare runs once', async () => {
    const d = deferred<void>();
    const prepare = vi.fn(async (r: CatalogBeerWithRating[]) => {
      await d.promise;
      // build a real prepared catalog after the gate opens
      return (await prepareCatalogChunked(r));
    });
    const cache = make({ getVersion: () => 0, load: () => rows, prepare });
    const a = cache.get();
    const b = cache.get();
    d.resolve();
    await Promise.all([a, b]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the TTL expires even if the version is unchanged', async () => {
    let clock = 1000;
    const load = vi.fn(() => rows);
    const cache = make({ getVersion: () => 0, load, now: () => clock, ttlMs: 5000 });
    await cache.get();               // built at t=1000
    clock = 7000;                    // > ttl later
    await cache.get();               // stale by TTL → triggers rebuild
    await cache.idle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a version bump during a rebuild leaves the result stale so the next get re-triggers', async () => {
    let version = 0;
    const load = vi.fn(() => rows);
    // prepare bumps the version mid-flight to simulate a write landing during rebuild.
    const prepare = vi.fn(async (r: CatalogBeerWithRating[]) => {
      version = 5;
      return prepareCatalogChunked(r);
    });
    const cache = make({ getVersion: () => version, load, prepare });
    await cache.get();               // cold build; captured version was 0, bumped to 5 mid-build
    await cache.get();               // 0 !== 5 → stale → bg rebuild
    await cache.idle();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('prepareCatalogChunked', () => {
  it('yields once per 2000-row chunk', async () => {
    const big: CatalogBeerWithRating[] = Array.from({ length: 2001 }, (_, i) => ({
      id: i + 1, brewery: `Brew ${i}`, name: `Beer ${i}`, abv: null, rating_global: null, untappd_id: null,
    }));
    const yieldSpy = vi.fn(() => Promise.resolve());
    const prepared = await prepareCatalogChunked(big, yieldSpy);
    expect(prepared.beers.length).toBe(2001);
    expect(yieldSpy.mock.calls.length).toBe(2); // ceil(2001/2000)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/catalog-cache.test.ts`
Expected: FAIL — cannot find module `./catalog-cache`.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/catalog-cache.ts
import type { DB } from '../storage/db';
import { loadCatalog } from '../storage/beers';
import { catalogVersion } from '../storage/catalog-version';
import { prepareBeer, makePreparedCatalog, type PreparedCatalog } from './matcher';
import { yieldToEventLoop, type CatalogBeerWithRating } from './match-list';

// ~0.027 ms/row on the prod catalog → 2000 rows ≈ ≤60 ms of normalization per chunk.
const PREP_CHUNK = 2000;
const DEFAULT_TTL_MS = 5 * 60_000;

export interface CachedCatalog {
  prepared: PreparedCatalog;
  byId: Map<number, CatalogBeerWithRating>;
}

export interface CatalogCache {
  // Returns the shared catalog (possibly stale), triggering a background rebuild
  // when the version has moved or the TTL has expired (stale-while-revalidate).
  get(): Promise<CachedCatalog>;
  // Resolves when no background rebuild is in flight. Test seam to await SWR completion.
  idle(): Promise<void>;
}

export interface CatalogCacheOptions {
  getVersion?: () => number;                                        // default: catalogVersion
  load?: () => CatalogBeerWithRating[];                             // default: loadCatalog(db)
  prepare?: (rows: CatalogBeerWithRating[]) => Promise<PreparedCatalog>; // default: chunked
  now?: () => number;                                               // default: Date.now
  ttlMs?: number;                                                   // default: 5 min
}

// Builds PreparedBeer[] in chunks, yielding to the event loop between chunks so the
// long-poll bot keeps processing updates during the ~1.2 s CPU burst, then assembles
// the catalog. Moved here from match-list.ts — the cache is now its only caller.
export async function prepareCatalogChunked(
  catalog: CatalogBeerWithRating[],
  yield_: () => Promise<void> = yieldToEventLoop,
): Promise<PreparedCatalog> {
  const beers = [];
  for (let i = 0; i < catalog.length; i += PREP_CHUNK) {
    const end = Math.min(i + PREP_CHUNK, catalog.length);
    for (let j = i; j < end; j++) beers.push(prepareBeer(catalog[j]));
    await yield_();
  }
  return makePreparedCatalog(beers);
}

export function createCatalogCache(db: DB, opts: CatalogCacheOptions = {}): CatalogCache {
  const getVersion = opts.getVersion ?? catalogVersion;
  const load = opts.load ?? (() => loadCatalog(db));
  const prepare = opts.prepare ?? ((rows) => prepareCatalogChunked(rows));
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  let current: { value: CachedCatalog; version: number; builtAt: number } | null = null;
  let rebuilding: Promise<void> | null = null;

  function rebuild(): Promise<void> {
    // Single-flight: a rebuild already running is reused, never doubled.
    if (rebuilding) return rebuilding;
    // Capture the version BEFORE load: a write landing mid-rebuild leaves
    // current.version < getVersion(), so the next get() re-triggers (no lost update).
    const version = getVersion();
    rebuilding = (async () => {
      const rows = load();
      const prepared = await prepare(rows);
      const byId = new Map(rows.map((r) => [r.id, r]));
      current = { value: { prepared, byId }, version, builtAt: now() };
    })().finally(() => { rebuilding = null; });
    return rebuilding;
  }

  return {
    async get() {
      if (current === null) {
        await rebuild();
        return current!.value;
      }
      const stale = current.version !== getVersion() || now() - current.builtAt > ttlMs;
      if (stale && !rebuilding) void rebuild();
      return current.value;
    },
    idle() {
      return rebuilding ?? Promise.resolve();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/catalog-cache.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/domain/catalog-cache.ts src/domain/catalog-cache.test.ts
git commit -m "feat(match): process-level PreparedCatalog cache (SWR + single-flight) (#277)"
```

---

## Task 4: refactor matchBeerList to take a prepared catalog

**Files:**
- Modify: `src/domain/match-list.ts`
- Modify: `src/domain/match-list.test.ts`

- [ ] **Step 1: Update the tests to the new signature (write them first — they fail against the old code)**

At the top of `src/domain/match-list.test.ts`, add an import and a helper right after the existing imports:

```ts
import { matchBeer, prepareCatalog } from './matcher';

// The route now hands matchBeerList an already-prepared catalog + id index; tests
// build them the same way the cache does.
function prep(catalog: CatalogBeerWithRating[]) {
  return { prepared: prepareCatalog(catalog), byId: new Map(catalog.map((c) => [c.id, c])) };
}
```

(If `matchBeer` is already imported on its own line, merge it into the `./matcher` import above and delete the old line.)

Then change **every** `matchBeerList(catalog, <drunk>, <ratings>, <items>[, opts])` call to pass the prepared pair. The mechanical transform for each call site is:

```ts
// before
const res = await matchBeerList(catalog, new Set([200]), new Map(), [ ... ]);
// after
const { prepared, byId } = prep(catalog);
const res = await matchBeerList(prepared, byId, new Set([200]), new Map(), [ ... ]);
```

Apply this to all call sites in the file (the `describe('matchBeerList')` block: lines ~12, ~32, ~45, ~51, ~57, ~68, ~77, ~85, ~98, and the `prepare-once equivalence` call ~124). For call sites that reuse the same catalog several times in one `it`, call `prep(catalog)` once at the top of that `it` and reuse `prepared`/`byId`.

Replace the entire `describe('matchBeerList — cooperative yielding', …)` block (the chunk-prep yielding moved to the cache) with an items-only version:

```ts
describe('matchBeerList — cooperative yielding', () => {
  it('yields once after each beer', async () => {
    const { prepared, byId } = prep([
      { id: 1, brewery: 'Brew 0', name: 'Beer 0', abv: null, rating_global: null },
    ]);
    const items = [
      { brewery: 'Brew 0', name: 'Beer 0' },   // exact match
      { brewery: 'Nowhere', name: 'Unknown' }, // no match
    ];
    const yieldSpy = vi.fn(() => Promise.resolve());
    await matchBeerList(prepared, byId, new Set(), new Map(), items, { yield: yieldSpy });
    expect(yieldSpy.mock.calls.length).toBe(items.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/match-list.test.ts`
Expected: FAIL — argument-count/type errors (old `matchBeerList` still takes `catalog` first).

- [ ] **Step 3: Rewrite `matchBeerList` and trim `match-list.ts`**

Update the imports at the top of `src/domain/match-list.ts` — drop `prepareBeer`, `makePreparedCatalog`; keep `matchPrepared`, `PreparedBeer`? (no longer needed) and the types actually used. The resulting import block:

```ts
import {
  matchPrepared,
  type CatalogBeer,
  type PreparedCatalog,
} from './matcher';
```

Keep `CatalogBeerWithRating`, `MatchInput`, `MatchedBeer`, `MatchListResult` interfaces unchanged. Keep `yieldToEventLoop` exported (the cache imports it). **Delete** the `PREP_CHUNK` constant and the entire `prepareCatalogChunked` function (moved to `catalog-cache.ts`).

Replace `matchBeerList` with:

```ts
export async function matchBeerList(
  prepared: PreparedCatalog,
  byId: Map<number, CatalogBeerWithRating>,
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: MatchInput[],
  opts: MatchListOptions = {},
): Promise<MatchListResult[]> {
  const yield_ = opts.yield ?? yieldToEventLoop;
  const out: MatchListResult[] = [];
  for (const item of items) {
    const raw = { brewery: item.brewery, name: item.name };
    const m = matchPrepared(item, prepared);
    if (!m) {
      out.push({ raw, matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null });
    } else {
      const beer = byId.get(m.id)!;
      out.push({
        raw,
        matched_beer: {
          id: beer.id,
          name: beer.name,
          brewery: beer.brewery,
          rating_global: beer.rating_global,
          untappd_id: beer.untappd_id ?? null,
        },
        is_drunk: m.source === 'exact' && drunkSet.has(m.id),
        drunk_uncertain: m.source === 'fuzzy' && drunkSet.has(m.id),
        user_rating: m.source === 'exact' ? (ratingByBeerId.get(m.id) ?? null) : null,
      });
    }
    await yield_();
  }
  return out;
}
```

Keep the `MatchListOptions` interface and the `yieldToEventLoop` export as they are. Leave the `CatalogBeer` import in place only if still referenced by `CatalogBeerWithRating extends CatalogBeer`; it is — keep it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/match-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "refactor(match): matchBeerList takes a prepared catalog + byId (#277)"
```

---

## Task 5: wire the cache into the /match route

**Files:**
- Modify: `src/api/routes/match.ts`
- Test: `src/api/routes/match.test.ts` (already exists; must keep passing — it seeds all beers before the first request, so the cold build sees them)

- [ ] **Step 1: Run the existing route tests to confirm the current green baseline**

Run: `npx vitest run src/api/routes/match.test.ts`
Expected: PASS (baseline before the change).

- [ ] **Step 2: Edit `src/api/routes/match.ts`**

Replace the `loadCatalog` import with the cache import:

```ts
// remove:
import { loadCatalog } from '../../storage/beers';
// add:
import { createCatalogCache } from '../../domain/catalog-cache';
```

Change `matchRoute` so the cache is constructed once per registration and consulted per request:

```ts
export function matchRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  const cache = createCatalogCache(deps.db);
  app.post('/match', zValidator('json', MatchBody), async (c) => {
    const telegramId = c.get('telegramId') ?? null;
    const { beers } = c.req.valid('json');

    const { prepared, byId } = await cache.get();
    // Anonymous callers get global-only results: empty drunk/ratings sets mean
    // is_drunk=false, user_rating=null, but matched_beer still carries the global
    // rating + untappd_id (⭐/⚪ badges render unchanged).
    const drunkSet = telegramId === null ? new Set<number>() : triedBeerIds(deps.db, telegramId);
    const ratings = telegramId === null ? new Map<number, number>() : latestRatingsByBeer(deps.db, telegramId);

    const results = await matchBeerList(prepared, byId, drunkSet, ratings, beers);
    return c.json({ results });
  });
}
```

- [ ] **Step 3: Run the route tests to verify they still pass**

Run: `npx vitest run src/api/routes/match.test.ts`
Expected: PASS — behavior is unchanged for a catalog seeded before the first request.

- [ ] **Step 4: Full test + typecheck sweep**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/match.ts
git commit -m "perf(match): serve /match from the shared catalog cache (#277)"
```

---

## Task 6: spec.md eventual-consistency note

**Files:**
- Modify: `spec.md` (the `#### POST /match` section, around the response description)

- [ ] **Step 1: Add the note**

In `spec.md`, immediately after the `POST /match` response block (right after the sentence ending `Серверна помилка → 500 { error: "internal" }.`), add a new paragraph:

```markdown
**Кеш каталогу (eventual consistency, #277).** `/match` матчить по спільному
процес-рівневому кешу підготовленого каталогу (`catalog-cache.ts`), інвалідованому
монотонним лічильником, який бампають записи в каталог (`upsertBeer`,
`recordLookupSuccess`, `mergeIntoCanonical`, `recordRatingSuccess`). Стратегія —
stale-while-revalidate: після зміни каталогу перезбірка йде у фоні (single-flight),
тож щойно записане пиво може з'явитися в результатах із затримкою до ~2 с (плюс один
запит). Контракт запиту/відповіді незмінний.
```

- [ ] **Step 2: Sanity-check the section renders / reads correctly**

Run: `grep -n "catalog-cache\|eventual consistency\|#277" spec.md`
Expected: the new lines are present in the `POST /match` section.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): note /match catalog cache eventual consistency (#277)"
```

---

## Final verification (run after all tasks)

- [ ] `npx vitest run` — full suite green.
- [ ] `npx tsc --noEmit` — no type errors.
- [ ] `npx eslint src` (or the repo's lint script) — clean.
- [ ] Grep check: `grep -rn "loadCatalog" src/api` returns nothing (the route no longer loads per request).
- [ ] Confirm every commit landed on the feature branch inside the worktree (`git log --oneline -8`), not on the main checkout.

---

## Self-Review Notes (author)

- **Spec coverage:** counter (Task 1) ✔, write instrumentation incl. the exact bump/no-bump split (Task 2) ✔, cache with SWR/single-flight/TTL/lazy-warmup/mid-rebuild capture (Task 3) ✔, `matchBeerList` refactor + per-user data stays per-request (Task 4) ✔, route wiring one-cache-per-process (Task 5) ✔, spec.md note (Task 6) ✔. No extension-facing change → `docs/extension-install-uk.md` intentionally untouched.
- **Type consistency:** `CachedCatalog { prepared, byId }`, `createCatalogCache(db, opts?)`, `matchBeerList(prepared, byId, drunkSet, ratingByBeerId, items, opts?)`, `catalogVersion()`/`bumpCatalogVersion()`, `prepareCatalogChunked(catalog, yield_?)` are used identically across tasks.
- **No placeholders:** every code and command step is concrete.
