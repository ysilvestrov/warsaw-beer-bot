# Prepare-Once Ontap Catalog + Incremental Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `refreshOntap` from re-preparing the ~30k-row catalog once per pub (~114 × 1.3 s of event-loop blocking/run); prepare it once per run via the chunked yielding build and keep it current by incrementally adding fresh orphans.

**Architecture:** Add an `add(row)` method to `PreparedCatalog` that appends to `beers` + the first-token index (leaving the memoized full searcher alone). `refreshOntap` builds one `PreparedCatalog` per run (injectable DI seam, default `prepareCatalogChunked`) and calls `add()` after each fresh-orphan `upsertBeer`. `cleanupPollutedOntap` gets the same chunked prepare (light touch, async).

**Tech Stack:** TypeScript, Vitest, better-sqlite3, pino, fast-fuzzy.

**Spec:** `docs/superpowers/specs/2026-07-12-refresh-ontap-prepare-once-design.md`

---

## File Structure

- `src/domain/matcher.ts` — add `PreparedCatalog.add(row)`; extract the per-row bucket-insert into a private `indexRow` helper shared by the initial build and `add()`.
- `src/domain/matcher.test.ts` — unit tests for `add()`.
- `src/domain/catalog-cache.ts` — widen `prepareCatalogChunked`'s param to `CatalogBeer[]`.
- `src/jobs/refresh-ontap.ts` — prepare once + `add()` on orphan insert; `prepareCatalog?` DI seam.
- `src/jobs/refresh-ontap.test.ts` — "prepared once per run" + cross-pub orphan reuse.
- `src/jobs/cleanup-polluted-ontap.ts` + `src/index.ts` — async chunked prepare.
- `src/jobs/cleanup-polluted-ontap.test.ts` — await the now-async call.
- `spec.md` — note in the refresh section.

---

## Task 1: `PreparedCatalog.add(row)` + `indexRow` helper

**Files:**
- Modify: `src/domain/matcher.ts` (interface `:46-57`; `makePreparedCatalog` `:82-122`)
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the END of `src/domain/matcher.test.ts` (imports `matchPrepared`, `prepareCatalog`, `prepareBeer`, `breweryAliases`, `vi`, and `type CatalogBeer` are already present on line 2 / at top — do not duplicate):

```ts
describe('makePreparedCatalog — add (#278)', () => {
  const mk = (id: number, brewery: string, name: string) =>
    prepareBeer({ id, brewery, name, abv: null });

  it('add() makes a row exact-matchable and present in both indexes', () => {
    const prepared = prepareCatalog([{ id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: null }]);
    expect(matchPrepared({ brewery: 'Stu Mostów', name: 'Buty Skejta' }, prepared)).toBeNull();
    prepared.add(mk(2, 'Stu Mostów', 'Buty Skejta'));
    expect(matchPrepared({ brewery: 'Stu Mostów', name: 'Buty Skejta' }, prepared))
      .toEqual({ id: 2, confidence: 1, source: 'exact' });
    expect(prepared.candidatesByFirstToken('stu').map((b) => b.id)).toContain(2);
    expect(prepared.breweryCandidates(breweryAliases('Stu Mostów')).map((b) => b.id)).toContain(2);
  });

  it('add() does not rebuild the memoized full searcher', () => {
    const build = vi.fn((rows) => prepareCatalog(rows).searcherFor(rows));
    const prepared = prepareCatalog([{ id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: null }], build);
    // First empty-pool fallback builds the full searcher once.
    matchPrepared({ brewery: 'Nowhere', name: 'Mystery' }, prepared);
    expect(build).toHaveBeenCalledTimes(1);
    prepared.add(mk(2, 'Elsewhere', 'Another Thing'));
    // add() must not build; a further empty-pool fallback reuses the memoized searcher.
    matchPrepared({ brewery: 'Faraway', name: 'Third Thing' }, prepared);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('add() buckets a collab row under each alias first token and dedupes', () => {
    const prepared = prepareCatalog([]);
    prepared.add(mk(5, 'Alpha / Beta', 'Shared Brew'));
    expect(prepared.candidatesByFirstToken('alpha').map((b) => b.id)).toEqual([5]);
    expect(prepared.candidatesByFirstToken('beta').map((b) => b.id)).toEqual([5]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/matcher.test.ts -t "makePreparedCatalog — add"`
Expected: FAIL — `prepared.add is not a function` (method doesn't exist yet).

- [ ] **Step 3: Add `add` to the interface**

In `src/domain/matcher.ts`, inside the `PreparedCatalog` interface (`:46-57`), add after `fullSearcher()`:

```ts
  fullSearcher(): PreparedSearcher;
  // Append a single already-prepared row: push to `beers` and index it under the first token
  // of each of its brewery aliases. Does NOT rebuild the memoized fullSearcher — a fresh row
  // is always reachable via its own brewery bucket, never the full-catalog path (#278).
  add(row: PreparedBeer): void;
```

- [ ] **Step 4: Extract `indexRow` and implement `add`**

In `makePreparedCatalog` (`src/domain/matcher.ts:82-122`), replace the eager index-build block:

```ts
  const byFirstToken = new Map<string, PreparedBeer[]>();
  for (const b of beers) {
    for (const alias of b.aliases) {
      const key = aliasFirstToken(alias);
      let bucket = byFirstToken.get(key);
      if (!bucket) byFirstToken.set(key, (bucket = []));
      if (bucket[bucket.length - 1] !== b) bucket.push(b);
    }
  }
```

with:

```ts
  const byFirstToken = new Map<string, PreparedBeer[]>();
  // Index one row under the first token of each of its brewery aliases. A row's aliases are
  // processed together, so the tail check dedupes a row whose aliases share a first token.
  // Shared by the initial eager build and add() (#278).
  const indexRow = (b: PreparedBeer): void => {
    for (const alias of b.aliases) {
      const key = aliasFirstToken(alias);
      let bucket = byFirstToken.get(key);
      if (!bucket) byFirstToken.set(key, (bucket = []));
      if (bucket[bucket.length - 1] !== b) bucket.push(b);
    }
  };
  for (const b of beers) indexRow(b);
```

Then in the returned object, add the `add` method next to `fullSearcher` (leave every other member unchanged):

```ts
    fullSearcher: () => (full ??= build(beers)),
    add: (row) => { beers.push(row); indexRow(row); },
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/domain/matcher.test.ts`
Expected: PASS (new `add` block + all pre-existing matcher tests, unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): PreparedCatalog.add for incremental catalog growth (#278)"
```

---

## Task 2: Widen `prepareCatalogChunked` to accept `CatalogBeer[]`

**Files:**
- Modify: `src/domain/catalog-cache.ts` (`:1-6` import, `:36-39` signature)

- [ ] **Step 1: Widen the parameter type**

In `src/domain/catalog-cache.ts`, add `type CatalogBeer` to the matcher import (`:4`):

```ts
import { prepareBeer, makePreparedCatalog, type PreparedCatalog, type CatalogBeer } from './matcher';
```

Change `prepareCatalogChunked`'s signature (`:36-39`) from:

```ts
export async function prepareCatalogChunked(
  catalog: CatalogBeerWithRating[],
  yield_: () => Promise<void> = yieldToEventLoop,
): Promise<PreparedCatalog> {
```

to:

```ts
export async function prepareCatalogChunked(
  catalog: CatalogBeer[],
  yield_: () => Promise<void> = yieldToEventLoop,
): Promise<PreparedCatalog> {
```

Leave the body and everything else unchanged. `CatalogBeerWithRating` still extends `CatalogBeer`, so the cache's default `prepare` and its `CatalogCacheOptions.prepare` type (which stays `CatalogBeerWithRating[]`) continue to accept `prepareCatalogChunked`.

- [ ] **Step 2: Typecheck + run the cache tests**

Run: `npx tsc --noEmit`
Expected: clean (no errors).
Run: `npx vitest run src/domain/catalog-cache.test.ts`
Expected: PASS (behavior unchanged — this is a type-only widening).

- [ ] **Step 3: Commit**

```bash
git add src/domain/catalog-cache.ts
git commit -m "refactor(catalog-cache): prepareCatalogChunked accepts CatalogBeer[] (#278)"
```

---

## Task 3: `refreshOntap` — prepare once per run + incremental add

**Files:**
- Modify: `src/jobs/refresh-ontap.ts` (imports `:13`; `Deps` `:20-34`; destructure `:37-46`; per-pub loop `:95-96`; orphan insert `:108-119`)
- Test: `src/jobs/refresh-ontap.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/jobs/refresh-ontap.test.ts`, add these imports at the top (merge with existing):

```ts
import { vi } from 'vitest';
import { prepareCatalogChunked } from '../domain/catalog-cache';
```

Add both tests inside the existing `describe('refreshOntap multi-city', …)` block (after the last test in it), so the `oneCity`, `geocoder`, and `beerCount` helpers defined in that block are in scope:

```ts
  test('prepares the catalog once per run regardless of pub count', async () => {
    const db = openDb(':memory:'); migrate(db);
    const index = `
      <div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>
      <div onclick="location.assign('https://pubb.ontap.pl/')"><div class="panel-body">B 1 taps</div></div>`;
    const pubHtml = (n: string) =>
      `<html><head><meta property="og:title" content="${n} / ontap.pl"></head>
        <body>${panel(1, 'Foo Brewery', 'Foo Hazy 6%', 'IPA')}</body></html>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/') return pubHtml('A');
        if (url === 'https://pubb.ontap.pl/') return pubHtml('B');
        return '';
      },
    };
    const prepareSpy = vi.fn((rows) => prepareCatalogChunked(rows));
    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder,
      cities: oneCity, lookupEnabled: false, prepareCatalog: prepareSpy,
    });
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  test('a fresh orphan from one pub is reused by a later pub (no duplicate insert)', async () => {
    const db = openDb(':memory:'); migrate(db);
    const index = `
      <div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>
      <div onclick="location.assign('https://pubb.ontap.pl/')"><div class="panel-body">B 1 taps</div></div>`;
    const sharedBody = `<body>${panel(1, 'Foo Brewery', 'Foo Hazy 6%', 'IPA')}</body>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/' || url === 'https://pubb.ontap.pl/')
          return `<html><head><meta property="og:title" content="P / ontap.pl"></head>${sharedBody}</html>`;
        return '';
      },
    };
    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder,
      cities: oneCity, lookupEnabled: false,
    });
    expect(beerCount(db)).toBe(1); // one orphan, reused across pubs — not duplicated
  });
```

NOTE for the implementer: confirm the two-`<div>` `index` string parses to two pubs via `parseOntapCityIndex` (the non-beer test at `src/jobs/refresh-ontap.test.ts:41` uses the same `location.assign('…') + panel-body` shape for one pub). If `parseOntapCityIndex` needs a specific wrapper, mirror that working shape exactly ×2. Do not change production parsing to satisfy the test.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts -t "prepares the catalog once per run"`
Expected: FAIL — `prepareCatalog` is not yet a recognized dep / spy never called (0 calls), because the job still re-prepares internally per pub without the seam.

- [ ] **Step 3: Update imports**

In `src/jobs/refresh-ontap.ts`, change the matcher import (`:13`) and add the cache import:

```ts
import { matchPrepared, prepareBeer, type CatalogBeer, type PreparedCatalog } from '../domain/matcher';
import { prepareCatalogChunked } from '../domain/catalog-cache';
```

(Drops the now-unused `prepareCatalog`; adds `prepareBeer` + the two types.)

- [ ] **Step 4: Add the DI seam to `Deps` and destructure it**

In the `Deps` interface (`:20-34`), add:

```ts
  breaker?: CircuitBreaker;     // default noopBreaker
  prepareCatalog?: (rows: CatalogBeer[]) => Promise<PreparedCatalog>;  // default: prepareCatalogChunked
}
```

In the destructure block (`:37-46`), add the default:

```ts
    breaker = noopBreaker,
    prepareCatalog = prepareCatalogChunked,
  } = deps;
```

- [ ] **Step 5: Build once, drop the per-pub rebuild, add on orphan insert**

Immediately after the destructure / the two `let` counters (before `for (const city of cities)`, `:51`), build the catalog once:

```ts
  let enrichBudget = inlineEnrichBudget;
  let inlineEnrichStopped = false;

  const prepared = await prepareCatalog(listBeerCatalog(db));

  for (const city of cities) {
```

Delete the per-pub rebuild (`:95-96`):

```ts
        const catalog = listBeerCatalog(db);
        const prepared = prepareCatalog(catalog);
```

(The tap loop keeps using the run-level `prepared`.)

In the orphan branch (`:108-119`), add the incremental `add` right after `upsertBeer`:

```ts
          } else {
            beerId = upsertBeer(db, {
              name,
              brewery,
              style: t.style,
              abv: t.abv,
              rating_global: t.u_rating,
              normalized_name: normalizeName(name),
              normalized_brewery: normalizeBrewery(brewery),
            });
            prepared.add(prepareBeer({ id: beerId, brewery, name, abv: t.abv }));
            upsertMatch(db, t.beer_ref, beerId, 1.0);
            isFreshOrphan = true;
          }
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts`
Expected: PASS — both new tests plus all pre-existing refresh-ontap tests (the orphan-count and cross-pub behaviors are preserved).

- [ ] **Step 7: Commit**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts
git commit -m "perf(refresh): prepare ontap catalog once per run + incremental orphan add (#278)"
```

---

## Task 4: `cleanupPollutedOntap` — async chunked prepare

**Files:**
- Modify: `src/jobs/cleanup-polluted-ontap.ts` (import `:4`; signature `:25`; prepare `:52`), `src/index.ts` (`:61`)
- Test: `src/jobs/cleanup-polluted-ontap.test.ts`

- [ ] **Step 1: Make the test await the (soon) async call**

Open `src/jobs/cleanup-polluted-ontap.test.ts`. Every call to `cleanupPollutedOntap(db, log)` must become `await cleanupPollutedOntap(db, log)`, and each enclosing `it`/`test` callback must be `async` (add `async` if missing). Read the file and update each call site — do not change any assertions. (There is no behavior change; the return value shape `CleanupResult` is identical, just wrapped in a Promise.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/jobs/cleanup-polluted-ontap.test.ts`
Expected: with the test now `await`-ing but the function still synchronous, TypeScript/`tsc` (Step 5) will flag `await` on a non-Promise, OR the tests still pass at runtime (awaiting a non-Promise is a no-op). Primary red signal comes at Step 5 tsc after the production change; if the runtime tests already pass here, proceed — the async conversion is the real change.

- [ ] **Step 3: Convert the production function to async chunked prepare**

In `src/jobs/cleanup-polluted-ontap.ts`, update the import (`:4`) — drop `prepareCatalog`, add the cache helper:

```ts
import { matchPrepared, type CatalogBeer } from '../domain/matcher';
import { prepareCatalogChunked } from '../domain/catalog-cache';
```

Change the signature (`:25`):

```ts
export async function cleanupPollutedOntap(db: DB, log: pino.Logger): Promise<CleanupResult> {
```

Change the prepare (`:52`):

```ts
  const preparedPool = await prepareCatalogChunked(pool);
```

(The two early `return { rewritten: 0, merged: 0 }` / `return { ... }` statements are unchanged — they now resolve the Promise.)

- [ ] **Step 4: Await at the call site**

In `src/index.ts:61`, change:

```ts
  cleanupPollutedOntap(db, log);
```

to:

```ts
  await cleanupPollutedOntap(db, log);
```

(It is inside `async function main()` — `:50`.)

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: clean.
Run: `npx vitest run src/jobs/cleanup-polluted-ontap.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/cleanup-polluted-ontap.ts src/index.ts src/jobs/cleanup-polluted-ontap.test.ts
git commit -m "perf(cleanup): chunked async prepare in cleanupPollutedOntap (#278)"
```

---

## Task 5: Full verification + spec note

**Files:**
- Modify: `spec.md` (after the "Багатомісто (#146)" `refreshOntap` paragraph, ~:926)

- [ ] **Step 1: Full suite + typecheck**

Run: `npm test`
Expected: all green (~1117+ tests, 0 failures).
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Add the spec note**

In `spec.md`, immediately AFTER the paragraph that ends with the `schema_version **14**` / `user_profiles.city` sentence (the "Багатомісто (#146)" block, ~:926), insert a new paragraph:

```
**Підготовка каталогу раз на запуск (#278).** `refreshOntap` готує prepared-каталог
**один раз на запуск** чанк-білдером із поступкою event-loop (`prepareCatalogChunked`),
а не заново на кожен паб. Свіжі orphan'и, створені під час запуску, інкрементально
додаються в пам'ять (`PreparedCatalog.add`), тож наступні паби матчаться на них
(exact/bucket-шлях) без дубль-вставки; memoized full-searcher при цьому НЕ перебудовується
(свіжий orphan завжди досяжний через власний бакет пивоварні). Прибирає ~114×1.3 с
синхронних блокувань event-loop на запуск. Startup-джоба `cleanupPollutedOntap` використовує
той самий чанк-білд (одноразовий, без інкрементального add).
```

Keep a blank line before and after so the markdown paragraph is well-formed.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): note prepare-once ontap catalog + incremental add (#278)"
```

---

## Self-Review Notes

- **Spec coverage:** `add()` + `indexRow` (Task 1), chunked param widening (Task 2), refresh prepare-once + DI seam + incremental add (Task 3), cleanup async light touch + call site (Task 4), verification + spec note (Task 5). All design sections mapped; no extension-doc impact.
- **Type consistency:** `add(row: PreparedBeer): void`; `prepareCatalog?: (rows: CatalogBeer[]) => Promise<PreparedCatalog>`; `prepareCatalogChunked(catalog: CatalogBeer[])`; `cleanupPollutedOntap(...): Promise<CleanupResult>` — used identically across tasks.
- **No placeholders:** every code + command step is concrete.
