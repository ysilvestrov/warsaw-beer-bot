# #405 Empty Brewery & Swapped Fields Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rescue 16 empty-brewery orphans (Sub-cohort A1) and clean swapped brand/name orphans (Sub-cohort A3) in `lookupBeer` when Algolia search returns the exact target beer, without regressing normal matching or weakening fuzzy thresholds.

**Architecture:**
1. **Empty brewery candidate-stripping (Sub-cohort A1):** When `inputBreweryAliases.length === 0`, candidate-stripping in Stage 2a compares candidate name-keys against `nameKeys(name, r.brewery_name)`, stripping the candidate's registered brewery from the shop input name. For single-token names, exact stripped name equality is allowed in the relaxed pool.
2. **Reachable swapped brand/name rescue (Sub-cohort A3):** Move the evaluation of the existing `swappedBrandNameScore` from the unreachable `strictPool` block to `brandPool`, verifying two-way token coverage (input brewery covers candidate beer name, and input name covers candidate registered brewery) with strict ABV corroboration.

**Tech Stack:** TypeScript, Vitest, Node.js 24, SQLite (`better-sqlite3`).

**Spec:** [`docs/superpowers/specs/2026-09/2026-09-15-405-empty-brewery-and-swapped-fields-design.md`](file:///home/ysi/warsaw-agy-bb/docs/superpowers/specs/2026-09/2026-09-15-405-empty-brewery-and-swapped-fields-design.md)

---

## Global Constraints

- Follow the Superpowers workflow and develop in an isolated worktree.
- Keep changes strictly focused on `src/domain/untappd-lookup.ts`, its test suite `src/domain/untappd-lookup.test.ts`, and `spec.md`.
- Do not modify `normalizeName`, `BREWERY_NOISE`, or the core `matcher.ts` functions.
- Empty brewery candidate-stripping must only activate when `inputBreweryAliases.length === 0` and `r.brewery_name` is non-empty and actively stripped.
- Swapped brand/name scoring requires full two-way token coverage and must not conflict with known ABV.
- Run full gate (`npm test && npm run typecheck`) after each task.

---

## File Map

- `src/domain/untappd-lookup.ts` — contains `lookupBeer`, `keyHits`, `relaxedExact`, and `swappedBrandNameScore` evaluation.
- `src/domain/untappd-lookup.test.ts` — unit tests for empty brewery matching, swapped field matching, and negative regression guards.
- `spec.md` — matching invariants section updates.

---

### Task 1: Candidate Brewery Stripping on Empty Input Brewery (Sub-cohort A1)

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (around lines 540-548 and 610-622)
- Test: `src/domain/untappd-lookup.test.ts`

**Interfaces:**
- Consumes: existing `nameKeys`, `stripBreweryFromName`, `normalizeBrewery`, `normalizeName`, `SearchResult`.
- Produces: `{ kind: 'matched', result }` for empty-brewery inputs when the candidate's brewery is stripped from `name`.

- [ ] **Step 1: Write failing tests for Sub-cohort A1**

Add tests to `src/domain/untappd-lookup.test.ts`:
```ts
describe('#405 Sub-cohort A1: empty input brewery candidate stripping', () => {
  test('matched: empty input brewery strips candidate brewery in exact nameKeys', async () => {
    const search = fakeSearch(() => [
      {
        bid: 5315178,
        beer_name: 'Two Keepers',
        brewery_name: 'Loca Deserta Meadery',
        style: 'Mead - Session / Short',
        abv: 6.5,
        global_rating: 4.0,
      },
    ]);
    const out = await lookupBeer({
      brewery: '',
      name: 'Loca Deserta Meadery Two Keepers',
      abv: 6.5,
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(5315178);
  });

  test('matched: empty input brewery strips candidate brewery for 1-token beer name', async () => {
    const search = fakeSearch(() => [
      {
        bid: 123456,
        beer_name: 'Five',
        brewery_name: 'Brasserie St-Feuillien',
        style: 'Belgian Blonde',
        abv: 5.0,
        global_rating: 3.6,
      },
    ]);
    const out = await lookupBeer({
      brewery: '',
      name: 'St-Feuillien Five',
      abv: 5.0,
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(123456);
  });

  test('not_found: empty input brewery refuses candidate whose brewery is not in name', async () => {
    const search = fakeSearch(() => [
      {
        bid: 999999,
        beer_name: 'Two Keepers',
        brewery_name: 'Unrelated Brewery',
        style: 'Mead',
        abv: 6.5,
        global_rating: 4.0,
      },
    ]);
    const out = await lookupBeer({
      brewery: '',
      name: 'Loca Deserta Meadery Two Keepers',
      abv: 6.5,
      search,
    });
    expect(out.kind).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "Sub-cohort A1"`
Expected: FAIL (both positive tests return `not_found`).

- [ ] **Step 3: Implement candidate brewery stripping for empty input brewery**

In `src/domain/untappd-lookup.ts`:
1. In Stage 2a (`keyHits`), when `inputBreweryAliases.length === 0`:
```ts
    const inputKeys = nameKeys(name, brewery);
    const keyHits = [...strictPool, ...relaxedPool].filter((r) => {
      const keys =
        inputBreweryAliases.length === 0 && r.brewery_name
          ? nameKeys(name, r.brewery_name)
          : inputKeys;
      return intersects(nameKeys(r.beer_name, r.brewery_name), keys);
    });
```
2. In relaxed exact fallback (`relaxedExact`), add exact stripped match when `inputBreweryAliases.length === 0`:
```ts
    const isRelaxedEmptyBreweryExact = (r: SearchResult): boolean => {
      if (inputBreweryAliases.length > 0 || !r.brewery_name) return false;
      const bNorm = normalizeBrewery(r.brewery_name);
      if (!bNorm) return false;
      const stripped = stripBreweryFromName(normalizeName(name), bNorm);
      if (stripped === normalizeName(name)) return false;
      return stripped === normalizeName(r.beer_name);
    };

    const relaxedExact = relaxedPool.filter(
      (r) =>
        relaxedTargetValues.has(normalizeName(r.beer_name)) ||
        relaxedIdentityValues.has(candIdentValue(r)) ||
        isRelaxedEmptyBreweryExact(r),
    );
```

- [ ] **Step 4: Run tests and verify PASS**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "Sub-cohort A1"`
Expected: PASS (all 3 tests pass).

- [ ] **Step 5: Run full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(#405): strip candidate brewery on empty input brewery in relaxed pool"
```

---

### Task 2: Reachable `swappedBrandNameScore` on `brandPool` (Sub-cohort A3)

**Files:**
- Modify: `src/domain/untappd-lookup.ts` (around lines 553-565 and 682-690)
- Test: `src/domain/untappd-lookup.test.ts`

**Interfaces:**
- Consumes: existing `swappedBrandNameScore`, `brandPool`, `pickUniqueByAbv`.
- Produces: `{ kind: 'matched', result }` for clean swapped brewery/name inputs.

- [ ] **Step 1: Write failing tests for Sub-cohort A3**

Add tests to `src/domain/untappd-lookup.test.ts`:
```ts
describe('#405 Sub-cohort A3: swapped brewery and beer name', () => {
  test('matched: swapped brewery and name resolve via swappedBrandNameScore', async () => {
    const search = fakeSearch(() => [
      {
        bid: 6757171,
        beer_name: 'PŁYNNE ZŁOTO',
        brewery_name: 'Browar Dziki Wschód',
        style: 'IPA - Imperial / Double',
        abv: 7.5,
        global_rating: 3.7,
      },
    ]);
    const out = await lookupBeer({
      brewery: 'Płynne Złoto Brewery',
      name: 'Dziki Wschód 18,5°',
      abv: 7.5,
      search,
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(6757171);
  });

  test('not_found: swapped resolution refuses incompatible ABV contradiction', async () => {
    const search = fakeSearch(() => [
      {
        bid: 6757171,
        beer_name: 'PŁYNNE ZŁOTO',
        brewery_name: 'Browar Dziki Wschód',
        style: 'IPA - Imperial / Double',
        abv: 7.5,
        global_rating: 3.7,
      },
    ]);
    const out = await lookupBeer({
      brewery: 'Płynne Złoto Brewery',
      name: 'Dziki Wschód 18,5°',
      abv: 4.5, // 3% ABV gap
      search,
    });
    expect(out.kind).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "Sub-cohort A3"`
Expected: FAIL (`matched` test returns `not_found`).

- [ ] **Step 3: Evaluate `swappedBrandNameScore` on `brandPool`**

In `src/domain/untappd-lookup.ts`:
In the brand stage (after `brandHits` at line 690):
```ts
    const swappedHits = brandPool.filter((r) =>
      targetNames.some(
        (target) => swappedBrandNameScore(target.value, inputBreweryAliases, r) != null,
      ),
    );
    if (swappedHits.length > 0) {
      const hit = pickUniqueByAbv(swappedHits, abv, true);
      if (hit) return { kind: 'matched', result: hit };
    }
```
And remove the unreachable `swappedBrandNameScore` call from the `strictPool`-only near-name block (line 562).

- [ ] **Step 4: Run tests and verify PASS**

Run: `npx vitest run src/domain/untappd-lookup.test.ts -t "Sub-cohort A3"`
Expected: PASS.

- [ ] **Step 5: Run full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/domain/untappd-lookup.ts src/domain/untappd-lookup.test.ts
git commit -m "fix(#405): evaluate swappedBrandNameScore on brandPool"
```

---

### Task 3: Invariants Documentation & Final Gate

**Files:**
- Modify: `spec.md` (matching invariants section)

- [ ] **Step 1: Update `spec.md` with new invariants**

In `spec.md`, under `Сила збігу пивоварні (enrich, lookupBeer)` and `Brand-as-beer-name (#138B)`:
```markdown
- **Зрізання броварні кандидата при порожній вхідній броварні (#405).** Якщо вхідна броварня
  порожня (#149, relaxed-гейт), exact name-key перетин обчислюється як
  `nameKeys(name, r.brewery_name)` — тобто броварня конкретного кандидата зрізається з вхідної
  повної назви. Для однотокенних назв exact-перевірка у relaxed-пулі приймає кандидата, якщо
  `stripBreweryFromName` видалив хоча б один токен і залишок точно дорівнює назві пива кандидата.
- **Двосторонній swapped-brand rescue (#405).** Якщо броварня і назва пива переплутані місцями
  (вхідна броварня покриває назву пива кандидата, а вхідна назва покриває зареєстровану
  броварню кандидата через `swappedBrandNameScore`), кандидат оцінюється у `brandPool` і
  приймається за умови відсутності суперечності ABV (`pickUniqueByAbv`).
```

- [ ] **Step 2: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS with 0 warnings/errors.

- [ ] **Step 3: Commit Task 3**

```bash
git add spec.md
git commit -m "docs(#405): document empty-brewery and swapped-fields invariants in spec.md"
```

---

## After the Plan

1. Rebase onto latest `origin/main` if moved:
   ```bash
   git fetch origin main && git rebase origin/main
   npm test && npm run typecheck
   ```
2. Create PR and wait for AI PR review checks.
3. Once deployed, run adjudication on #405:
   ```bash
   npm run adjudicate -- --issue 405
   ```
