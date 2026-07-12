# Non-blocking /match (cooperative yield) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `POST /match` from freezing the bot by yielding the event loop during catalog preparation (chunked) and between input beers, keeping match results byte-for-byte identical.

**Architecture:** `matcher.ts` stays the synchronous, pure matching kernel — refactored only to expose `prepareBeer` (per-row) and `makePreparedCatalog` (assembles the lazy-searcher object). The async/yielding orchestration lives in `match-list.ts`: `matchBeerList` becomes async, builds the prepared catalog in `PREP_CHUNK`-sized chunks with `setImmediate` yields, and yields between beers. The `/match` route awaits it.

**Tech Stack:** TypeScript, `fast-fuzzy`, Hono, Jest, better-sqlite3, `setImmediate`.

**Spec:** `docs/superpowers/specs/2026-06-08-match-nonblocking-cooperative-yield-design.md`

---

### Task 1: Refactor `matcher.ts` — extract `prepareBeer` + `makePreparedCatalog`

Behavior-preserving. `prepareCatalog` keeps its signature and behavior; the existing
`matcher.test.ts` suite (including the Task-1 lazy/memoized + field tests) must stay green.

**Files:**
- Modify: `src/domain/matcher.ts:49-65`
- Test: `src/domain/matcher.test.ts` (existing suite must pass; one small test added)

- [ ] **Step 1: Replace `prepareCatalog` with `prepareBeer` + `makePreparedCatalog` + a delegating `prepareCatalog`**

Replace the current `prepareCatalog` (lines 47-65) with:

```ts
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
```

- [ ] **Step 2: Run the existing matcher suite — must stay green**

Run: `npx jest src/domain/matcher.test.ts`
Expected: PASS, same count as before (53 tests). The lazy/memoized test still passes because
`prepareCatalog(cat, build)` forwards `build` to `makePreparedCatalog`.

- [ ] **Step 3: Add a `prepareBeer` unit test**

Append to `src/domain/matcher.test.ts` (the import line already pulls from `./matcher`; add
`prepareBeer` to it):

```ts
import { prepareBeer } from './matcher';

describe('prepareBeer', () => {
  it('precomputes nameNorm, breweryNorm and aliases', () => {
    const p = prepareBeer({ id: 7, brewery: 'Piwne Podziemie Brewery', name: 'Hopinka IPA', abv: 6 });
    expect(p.id).toBe(7);
    expect(p.nameNorm).toBe('hopinka');          // STYLE_WORD "ipa" stripped
    expect(p.breweryNorm).toBe('piwne podziemie'); // noise word "brewery" stripped
    expect(p.aliases).toEqual(['piwne podziemie']);
  });
});
```

- [ ] **Step 4: Run the added test + typecheck**

Run: `npx jest src/domain/matcher.test.ts -t "prepareBeer" && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "refactor(matcher): extract prepareBeer + makePreparedCatalog building blocks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Async, yielding `matchBeerList` in `match-list.ts`

Make `matchBeerList` async; chunk-yield during prep and yield between beers. The per-item
result mapping is unchanged.

**Files:**
- Modify: `src/domain/match-list.ts`
- Test: `src/domain/match-list.test.ts`

- [ ] **Step 1: Rewrite `match-list.ts` to the async, yielding version**

Replace the import line and the `matchBeerList` function. The interfaces
(`CatalogBeerWithRating`, `MatchInput`, `MatchedBeer`, `MatchListResult`) stay unchanged.

New import (top of file, replacing the current `import { matchPrepared, prepareCatalog, type CatalogBeer } from './matcher';`):

```ts
import {
  matchPrepared,
  prepareBeer,
  makePreparedCatalog,
  type CatalogBeer,
  type PreparedBeer,
  type PreparedCatalog,
} from './matcher';
```

Replace the `matchBeerList` function (the whole `export function matchBeerList(...) { ... }`) with:

```ts
// ~0.027 ms/row on the prod catalog → 2000 rows ≈ ≤60 ms of normalization per chunk.
const PREP_CHUNK = 2000;

// Hands control back to the event loop so the long-poll bot processes its updates
// between CPU bursts. setImmediate fires after pending I/O callbacks.
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
  // DI seam so tests can count yields deterministically; production uses the default.
  yield?: () => Promise<void>;
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
        matched_beer: {
          id: beer.id,
          name: beer.name,
          brewery: beer.brewery,
          rating_global: beer.rating_global,
        },
        is_drunk: drunkSet.has(m.id),
        user_rating: ratingByBeerId.get(m.id) ?? null,
      });
    }
    await yield_();
  }
  return out;
}
```

Note: `CatalogBeer` is still imported because `CatalogBeerWithRating extends CatalogBeer`.

- [ ] **Step 2: Update existing `match-list.test.ts` cases to `await`**

Every `matchBeerList(...)` call in `src/domain/match-list.test.ts` must be awaited and its
test made `async`. Concretely:
- `it('marks a matched, drunk beer with its personal rating', async () => { const res = await matchBeerList(...); ... })`
- `it('drunk via had-list only → is_drunk true, user_rating null', async () => { const res = await matchBeerList(...); ... })`
- `it('no catalog match → matched_beer null, not drunk', async () => { const res = await matchBeerList(...); ... })`
- `it('preserves input order', async () => { const res = await matchBeerList(...); ... })`
- In `describe('matchBeerList — prepare-once equivalence', ...)`: `it('per-batch result equals matching each beer alone', async () => { const batch = await matchBeerList(bigCatalog, new Set(), new Map(), inputs); inputs.forEach(...) })` — `matchBeer` (sync) stays un-awaited.

- [ ] **Step 3: Add the yield test**

Append to `src/domain/match-list.test.ts`:

```ts
describe('matchBeerList — cooperative yielding', () => {
  it('yields between prep chunks and after each beer', async () => {
    // 2001 rows → ceil(2001/2000) = 2 prep-chunk yields.
    const big: CatalogBeerWithRating[] = Array.from({ length: 2001 }, (_, i) => ({
      id: i + 1, brewery: `Brew ${i}`, name: `Beer ${i}`, abv: null, rating_global: null,
    }));
    const items = [
      { brewery: 'Brew 0', name: 'Beer 0' },   // exact match
      { brewery: 'Nowhere', name: 'Unknown' }, // empty-pool fallback
    ];
    const yieldSpy = jest.fn(() => Promise.resolve());
    await matchBeerList(big, new Set(), new Map(), items, { yield: yieldSpy });
    // 2 prep-chunk yields + 1 yield per beer.
    expect(yieldSpy.mock.calls.length).toBe(2 + items.length);
  });
});
```

- [ ] **Step 4: Run match-list tests + typecheck**

Run: `npx jest src/domain/match-list.test.ts && npx tsc --noEmit`
Expected: PASS (all updated cases + equivalence + yield), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "perf(match): matchBeerList yields the event loop during prep and between beers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Make the `/match` route async

**Files:**
- Modify: `src/api/routes/match.ts:26-36`

- [ ] **Step 1: Await the now-async `matchBeerList`**

Change the handler to `async` and `await` the call:

```ts
  app.post('/match', zValidator('json', MatchBody), async (c) => {
    const telegramId = c.get('telegramId');
    const { beers } = c.req.valid('json');

    const catalog = loadCatalog(deps.db);
    const drunkSet = triedBeerIds(deps.db, telegramId);
    const ratings = latestRatingsByBeer(deps.db, telegramId);

    const results = await matchBeerList(catalog, drunkSet, ratings, beers);
    return c.json({ results });
  });
```

- [ ] **Step 2: Run the API tests + typecheck**

Run: `npx jest src/api && npx tsc --noEmit`
Expected: PASS, tsc clean. (Hono awaits async handlers; `app.onError` still wraps thrown errors.)

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/match.ts
git commit -m "perf(api): await async matchBeerList in /match handler (non-blocking)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Update benchmark, full suite, spec.md review

**Files:**
- Modify: `scripts/bench-match.ts`

- [ ] **Step 1: Await the async `matchBeerList` in the benchmark**

In `scripts/bench-match.ts`, the matching block uses top-level `await` (the file is ESM —
it has imports). Change:

```ts
const t0 = performance.now();
const results = await matchBeerList(catalog, new Set(), new Map(), beers);
const ms = performance.now() - t0;
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all green (existing + the 2 new tests: `prepareBeer`, yielding).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (`scripts/` is outside `tsconfig` `include`, so the bench file runs via `tsx`.)

- [ ] **Step 4: (Optional, manual) Re-run the benchmark against prod DB**

Run: `npx tsx scripts/bench-match.ts /var/lib/warsaw-beer-bot/bot.db /home/ysi/warsaw-beer-bot/input.json`
Expected: matched count unchanged (29/48); total ≈ 2 s (yielding adds only negligible
`setImmediate` overhead — it does not reduce wall-clock, it interleaves).

- [ ] **Step 5: Review `spec.md` for a `/match`-is-synchronous note**

Run: `grep -ni "synchron\|better-sqlite3 виклик\|/match\|event loop\|подія" spec.md`
The public `/match` contract and results are unchanged. §3.3 currently frames "synchronous
better-sqlite3 calls" as not-external-I/O — that statement stays true. If a sentence asserts
`/match` is fully synchronous / blocks the loop, update it to note it now yields cooperatively,
in this PR (per CLAUDE.md). If nothing relevant, note "no spec change needed" in the PR body.

- [ ] **Step 6: Commit any spec.md change (only if made)**

```bash
git add spec.md
git commit -m "docs(spec): note /match yields the event loop cooperatively

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Cardinal rule:** match results must not change. The Task-1 equivalence test
  (`matchBeerList` vs per-beer `matchBeer`) and the full `matcher.test.ts` suite are the
  guards. Yielding is pure scheduling — it must not touch the matching logic.
- `matcher.ts` stays synchronous and pure. Do NOT add `async`/`setImmediate` there — all
  yielding lives in `match-list.ts`. The two job callers (`refresh-ontap`,
  `cleanup-polluted-ontap`) and the `matchBeer` wrapper keep using the sync `prepareCatalog`.
- `opts.yield` is a test seam; production passes nothing and uses `yieldToEventLoop`.
- Worker-thread / true off-thread matching is out of scope — GitHub issue #84.
```
