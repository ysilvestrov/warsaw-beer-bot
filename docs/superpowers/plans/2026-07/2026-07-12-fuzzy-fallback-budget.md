# Bounded Fuzzy-Fallback Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the number of per-request items allowed to hit the full-catalog fuzzy fallback (`fullSearcher()`), so one bad page can't burn ~18s of CPU, and log the fallback's hit-rate.

**Architecture:** A per-request mutable `FallbackBudget` (limit 20) is created in `matchBeerList`, passed to each `matchPrepared` call, and consumed only on the empty-brewery-pool (full-catalog) path. Items past the budget return `matched_beer: null`. `matchBeerList` returns the budget alongside results; `match.ts` logs it at `info`.

**Tech Stack:** TypeScript, Vitest, Hono, pino.

**Spec:** `docs/superpowers/specs/2026-07-12-fuzzy-fallback-budget-design.md`

---

## File Structure

- `src/domain/matcher.ts` — add `FullFallbackBudget` constant, `FallbackBudget` interface, `createFallbackBudget()`, and an optional `budget` param on `matchPrepared` that gates the full-catalog fuzzy branch (currently `matcher.ts:406-420`).
- `src/domain/matcher.test.ts` — unit tests for budget gating + counters + backward-compatible ungated path.
- `src/domain/match-list.ts` — create one budget per call, pass to `matchPrepared`, return `{ results, fallback }` (was `MatchListResult[]`).
- `src/domain/match-list.test.ts` — update existing callers to the new shape; add a budget-sharing test.
- `src/api/routes/match.ts` — destructure `{ results, fallback }`, log one `info` line, still respond `{ results }`.
- `spec.md` — one-paragraph note in the "Brewery-gate як first-token індекс" section.

---

## Task 1: Budget type, factory, and gated `matchPrepared`

**Files:**
- Modify: `src/domain/matcher.ts` (add exports near `FUZZY_THRESHOLD` at `:20`; edit fuzzy branch at `:406-420`; add `budget` param at `:301-304`)
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to the end of `src/domain/matcher.test.ts`. Note `createFallbackBudget`, `FULL_FALLBACK_BUDGET`, and `prepareBeer` must be added to the existing import on line 2 (`prepareBeer` is already imported).

```ts
import { matchBeer, /* …existing… */ prepareCatalog, matchPrepared, prepareBeer,
  createFallbackBudget, FULL_FALLBACK_BUDGET, type CatalogBeer } from './matcher';

describe('matchPrepared — full-catalog fallback budget (#279)', () => {
  const cat: CatalogBeer[] = [c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1 })];

  // A fake searcher (injected via the build seam) makes the full-catalog hit
  // deterministic without depending on fast-fuzzy's exact scoring. `as never` matches
  // the repo's test-cast convention (e.g. src/config/env.test.ts).
  const hitBuild = () =>
    ({ search: () => [{ item: prepareBeer(c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu' })), score: 0.9 }] }) as never;

  it('default budget constant is 20', () => {
    expect(FULL_FALLBACK_BUDGET).toBe(20);
    expect(createFallbackBudget().remaining).toBe(20);
  });

  it('counts a full-catalog attempt and hit', () => {
    const prepared = prepareCatalog(cat, hitBuild);
    const budget = createFallbackBudget();
    // Unknown brewery → empty pool → full-catalog fallback.
    const m = matchPrepared({ brewery: 'Nowhere', name: 'Atak Chmielu' }, prepared, budget);
    expect(m?.id).toBe(1);
    expect(budget.attempts).toBe(1);
    expect(budget.hits).toBe(1);
    expect(budget.budgetSkipped).toBe(0);
    expect(budget.remaining).toBe(19);
  });

  it('returns null and records budgetSkipped once the budget is exhausted', () => {
    const prepared = prepareCatalog(cat, hitBuild);
    const budget = createFallbackBudget(1);
    const first = matchPrepared({ brewery: 'Nowhere', name: 'Atak Chmielu' }, prepared, budget);
    const second = matchPrepared({ brewery: 'Elsewhere', name: 'Atak Chmielu' }, prepared, budget);
    expect(first?.id).toBe(1);
    expect(second).toBeNull();
    expect(budget.attempts).toBe(2);
    expect(budget.hits).toBe(1);
    expect(budget.budgetSkipped).toBe(1);
    expect(budget.remaining).toBe(0); // not driven negative
  });

  it('brewery-bucket fuzzy path does not touch the budget', () => {
    const prepared = prepareCatalog(cat);
    const budget = createFallbackBudget();
    // 'Pinta' (typo 'Pintaa') still buckets under first token 'pinta' → non-empty pool.
    matchPrepared({ brewery: 'Pinta', name: 'Atak Chmiel' }, prepared, budget);
    expect(budget.attempts).toBe(0);
    expect(budget.budgetSkipped).toBe(0);
  });

  it('omitting the budget leaves the full fallback ungated (matchBeer path)', () => {
    // matchBeer never passes a budget; unknown-brewery fuzzy still works as today.
    const m = matchBeer({ brewery: 'Stu Mostow', name: 'Buty Skejty' }, [
      c({ id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta', abv: 5.0 }),
    ]);
    expect(m?.id).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/matcher.test.ts -t "full-catalog fallback budget"`
Expected: FAIL — `createFallbackBudget`/`FULL_FALLBACK_BUDGET` are not exported (import/type error), or `matchPrepared` ignores the third arg.

- [ ] **Step 3: Add the constant, interface, and factory**

In `src/domain/matcher.ts`, just after the existing `const FUZZY_THRESHOLD = 0.75;` line (`:20`), add:

```ts
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
```

- [ ] **Step 4: Add the `budget` param and gate the fuzzy branch**

In `src/domain/matcher.ts`, change the `matchPrepared` signature (`:301-304`) to accept an optional budget:

```ts
export function matchPrepared(
  input: { brewery: string; name: string; abv?: number | null },
  prepared: PreparedCatalog,
  budget?: FallbackBudget,
): MatchResult | null {
```

Then replace the fuzzy-fallback block (`:406-420`, from the `// Fuzzy fallback:` comment through the final `return`) with:

```ts
  // Fuzzy fallback: prefer rows whose brewery aliases overlap the input's, otherwise the
  // full catalog (shared, lazily-built Searcher). The full-catalog path is ~89ms/item over
  // 30k rows (#279); gate it per request so one bad page can't burn ~18s of CPU. Items past
  // the budget return null (stay ⚪). The brewery-bucket path is small/cheap → ungated.
  const pool = breweryMatches;
  // Use the first alias as the search seed — full normalized brewery already appears at
  // index 0 of breweryAliases when no slash is present.
  const seedBrewery = inputAliases[0] ?? '';
  let searcher: PreparedSearcher; // in-file type declared at matcher.ts:41
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
  if (pool.length === 0 && budget) budget.hits++;
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/domain/matcher.test.ts`
Expected: PASS (new budget block + all existing matcher tests, including "builds the full-catalog Searcher at most once" which still calls `matchPrepared` with no budget).

- [ ] **Step 6: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(match): budget-gate full-catalog fuzzy fallback (#279)"
```

---

## Task 2: Thread the budget through `matchBeerList`

**Files:**
- Modify: `src/domain/match-list.ts:1-5` (imports), `:44-78` (body + return type)
- Test: `src/domain/match-list.test.ts`

- [ ] **Step 1: Update the existing tests to the new return shape and add a budget test**

The return type becomes `{ results, fallback }`, so every existing assertion that reads `matchBeerList`'s result as an array must read `.results`. Make these edits in `src/domain/match-list.test.ts`:

- Import the budget constant at the top:
  ```ts
  import { matchBeer, prepareCatalog, FULL_FALLBACK_BUDGET } from './matcher';
  ```
- In `'marks a matched, drunk beer with its personal rating'`: change `expect(res).toEqual([ {…} ])` to `expect(res.results).toEqual([ {…} ])`.
- In `'a fuzzy match never claims drunk or personal rating'`: change the three `res[0]` reads to `res.results[0]`.
- In `'drunk_uncertain is false for exact, non-drunk-fuzzy, and no-match'`: change `exactDrunk[0]` → `exactDrunk.results[0]` (both lines), `fuzzyNotDrunk[0]` → `fuzzyNotDrunk.results[0]` (both lines), `noMatch[0]` → `noMatch.results[0]` (both lines).
- In `'passes untappd_id through to matched_beer'`: change `res[0]` → `res.results[0]`.
- In `'drunk via had-list only → is_drunk true, user_rating null'`: change both `res[0]` → `res.results[0]`.
- In `'no catalog match → matched_beer null, not drunk'`: change `expect(res[0]).toEqual({…})` → `expect(res.results[0]).toEqual({…})`.
- In `'preserves input order'`: change `res.map(...)` → `res.results.map(...)`.
- In `'per-batch result equals matching each beer alone'`: change `batch[i]` → `batch.results[i]`.
- The `'yields once after each beer'` test ignores the return value — leave it.

Then add this new test at the end of the top-level `describe('matchBeerList', …)` block (before its closing `});` on line 119):

```ts
  it('shares one full-fallback budget across the batch and returns it', async () => {
    // A catalog of one beer; N+1 unknown-brewery inputs all fall to the full-catalog
    // path. With a batch larger than the budget, the surplus is skipped.
    const { prepared, byId } = prep([
      { id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
    ]);
    const n = FULL_FALLBACK_BUDGET + 3;
    const items = Array.from({ length: n }, (_, i) => ({ brewery: `Unknown${i}`, name: `Mystery ${i}` }));
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), items);
    expect(res.results).toHaveLength(n);
    expect(res.fallback.attempts).toBe(n);
    expect(res.fallback.budgetSkipped).toBe(3);
    expect(res.fallback.remaining).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/match-list.test.ts`
Expected: FAIL — `res.results`/`res.fallback` are undefined (matchBeerList still returns an array).

- [ ] **Step 3: Create, pass, and return the budget**

In `src/domain/match-list.ts`, update the import (`:1-5`) to add the budget factory and type:

```ts
import {
  matchPrepared,
  createFallbackBudget,
  type CatalogBeer,
  type PreparedCatalog,
  type FallbackBudget,
} from './matcher';
```

Change the `matchBeerList` return type (`:44-51`) and body (`:52-78`):

```ts
export async function matchBeerList(
  prepared: PreparedCatalog,
  byId: Map<number, CatalogBeerWithRating>,
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: MatchInput[],
  opts: MatchListOptions = {},
): Promise<{ results: MatchListResult[]; fallback: FallbackBudget }> {
  const yield_ = opts.yield ?? yieldToEventLoop;
  const budget = createFallbackBudget();
  const out: MatchListResult[] = [];
  for (const item of items) {
    const raw = { brewery: item.brewery, name: item.name };
    const m = matchPrepared(item, prepared, budget);
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
  return { results: out, fallback: budget };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/match-list.test.ts`
Expected: PASS (all existing tests via `.results`, plus the new budget-sharing test).

- [ ] **Step 5: Commit**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "feat(match): return per-request fallback budget from matchBeerList (#279)"
```

---

## Task 3: Log fallback stats in the `/match` route

**Files:**
- Modify: `src/api/routes/match.ts:41-42`
- Test: `src/api/routes/match.test.ts` (existing route tests already assert `body.results`; the response shape is unchanged, so they must still pass)

- [ ] **Step 1: Write a failing test that the log line is emitted**

Add this test inside `describe('POST /match', …)` in `src/api/routes/match.test.ts`. It captures pino output by giving `setup` a spy logger — extend `setup` to accept an optional log, then assert the line. Replace the current `const log = pino({ level: 'silent' });` line and `matchRoute(app, { db, env: {} as never, log });` calls so both `appAs`/`appAnon` use the passed `log`:

```ts
function setup(log = pino({ level: 'silent' })) {
  // …unchanged body up to the two matchRoute calls…
  // (both appAs and appAnon must pass this same `log` into matchRoute)
}
```

Then add:

```ts
  it('logs full-fallback stats at info', async () => {
    const lines: any[] = [];
    const log = pino({ level: 'info' }, { write: (s: string) => lines.push(JSON.parse(s)) });
    const { appAs } = setup(log);
    await post(appAs(1), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    const stat = lines.find((l) => l.msg === 'match fallback stats');
    expect(stat).toBeTruthy();
    expect(stat.items).toBe(1);
    expect(stat.fullFallback).toEqual({ attempts: 0, hits: 0, budgetSkipped: 0 });
  });
```

(The `pino(opts, destination)` two-arg form writes NDJSON to the provided sink; each line is one JSON record with `msg` + merged fields.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/api/routes/match.test.ts -t "logs full-fallback stats"`
Expected: FAIL — no `'match fallback stats'` line is emitted (route doesn't log), and/or `res.json()` in other tests still works because response shape is unchanged.

- [ ] **Step 3: Destructure and log in the route**

In `src/api/routes/match.ts`, replace lines `:41-42`:

```ts
    const results = await matchBeerList(prepared, byId, drunkSet, ratings, beers);
    return c.json({ results });
```

with:

```ts
    const { results, fallback } = await matchBeerList(prepared, byId, drunkSet, ratings, beers);
    deps.log.info(
      {
        items: beers.length,
        fullFallback: {
          attempts: fallback.attempts,
          hits: fallback.hits,
          budgetSkipped: fallback.budgetSkipped,
        },
      },
      'match fallback stats',
    );
    return c.json({ results });
```

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `npx vitest run src/api/routes/match.test.ts`
Expected: PASS (new log test + all existing `body.results` assertions, which are unaffected by the added log).

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/match.ts src/api/routes/match.test.ts
git commit -m "feat(match): log per-request full-fallback stats at info (#279)"
```

---

## Task 4: Full verification + spec update

**Files:**
- Modify: `spec.md` (append to the "Brewery-gate як first-token індекс (продуктивність)" paragraph, around `:707-709`)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — full suite green (no regressions from the `matchBeerList` signature change).

- [ ] **Step 2: Typecheck the build**

Run: `npx tsc --noEmit`
Expected: no errors (the `matchBeerList` return-shape change has exactly three callers: `match.ts`, and the two test files, all updated).

- [ ] **Step 3: Add the spec note**

In `spec.md`, at the end of the paragraph that ends `…з індексом — ~2 с.` (around `:709`), append:

```
Повнокаталожний fuzzy-fallback (порожній бакет пивоварні) обмежений **бюджетом на запит**
(`FULL_FALLBACK_BUDGET`, дефолт 20): кожен такий айтем коштує ~89 мс на ~30k рядків, тож без
ліміту одна «сміттєва» сторінка (200 пив) спалила б ~18 с CPU у спільному event-loop (#279).
Айтеми понад бюджет повертають `matched_beer: null` (лишаються ⚪); бакетований fuzzy не
лімітується. Статистика (`attempts`/`hits`/`budgetSkipped`) логується `info` на кожен `/match`.
```

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): note per-request full-fallback fuzzy budget (#279)"
```

---

## Self-Review Notes

- **Spec coverage:** budget object + factory (Task 1), gated `matchPrepared` with optional budget (Task 1), brewery-bucket path ungated (Task 1 test), `matchBeerList` owns + returns budget (Task 2), `info` log in route (Task 3), spec note, no extension-doc impact (Task 4). All spec sections mapped.
- **Type consistency:** `FallbackBudget` fields (`remaining`/`attempts`/`hits`/`budgetSkipped`), `createFallbackBudget(limit?)`, `FULL_FALLBACK_BUDGET`, and `matchBeerList` return `{ results, fallback }` are used identically across all tasks.
- **No placeholders:** every code + command step is concrete.
