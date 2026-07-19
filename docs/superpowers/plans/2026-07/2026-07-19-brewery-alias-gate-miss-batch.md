# Brewery alias / gate-miss batch (#318) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rescue the live on-tap + shop-sourced `matcher_bug` brewery-gate misses by adding one generic brewery-descriptor to `BREWERY_NOISE` and 11 verified curated `ALIAS_PAIRS`.

**Architecture:** Two additive edits in `src/domain/`: `normalize.ts` (`BREWERY_NOISE` gains `minipivovar`) and `brewery-aliases.ts` (11 new `[shopForm, untappdForm]` pairs). All normalized forms are precomputed and verified via `normalizeBrewery`. No logic changes.

**Tech Stack:** TypeScript, Vitest. Design doc: `docs/superpowers/specs/2026-07/2026-07-19-brewery-alias-gate-miss-batch-design.md`.

---

## File Structure

- `src/domain/normalize.ts` — `BREWERY_NOISE` set: add `'minipivovar'`.
- `src/domain/normalize.test.ts` — descriptor-strip test.
- `src/domain/brewery-aliases.ts` — `ALIAS_PAIRS` array: append 11 pairs.
- `src/domain/brewery-aliases.test.ts` — new pairs resolve via `aliasNeighbors`.

**Plan-time verification already done** (do not re-derive; do not add extras): `normalizeBrewery` was run on every pair to get the exact normalized strings below. Two candidate descriptors were evaluated and **rejected** (no rescue): `měšťanský` (`Měšťanský pivovar v Poličce` → `mestansky v policce` ≠ `Polička` → `policka`) and `minibrowar` (no orphan evidence). Only `minipivovar` is added.

**Repo conventions:** run a single test file with `npx vitest run <path>`. `aliasNeighbors`, `aliasKeys` are exported from `brewery-aliases.ts`; `normalizeBrewery`, `BREWERY_NOISE` from `normalize.ts`. Follow existing test style (bare/`describe` blocks).

---

## Task 1: Add `minipivovar` to `BREWERY_NOISE`

**Files:**
- Modify: `src/domain/normalize.ts` (`BREWERY_NOISE`, the compound-descriptor line ending `'nanobrowar', 'nanobrowary', 'nanobryggeri',`)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/normalize.test.ts`:

```ts
describe('minipivovar brewery noise (#318)', () => {
  test('minipivovar is stripped so it matches the bare brand', () => {
    expect(normalizeBrewery('Minipivovar Skřečoňský žabák')).toBe('skreconsky zabak');
    expect(normalizeBrewery('Skřečoňský žabák')).toBe('skreconsky zabak');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/normalize.test.ts -t "minipivovar"`
Expected: FAIL — `normalizeBrewery('Minipivovar Skřečoňský žabák')` returns `'minipivovar skreconsky zabak'`.

- [ ] **Step 3: Add `minipivovar` to `BREWERY_NOISE`**

In `src/domain/normalize.ts`, change the compound-descriptor line from:

```ts
  'nanobrowar', 'nanobrowary', 'nanobryggeri',
```

to:

```ts
  'nanobrowar', 'nanobrowary', 'nanobryggeri', 'minipivovar',
```

(`minipivovar` is a single glued Czech "micro-brewery" token, exactly the compound-descriptor class this line documents.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/normalize.test.ts -t "minipivovar"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(matcher): strip 'minipivovar' brewery descriptor (#318)"
```

---

## Task 2: Add the 11 curated `ALIAS_PAIRS`

**Files:**
- Modify: `src/domain/brewery-aliases.ts` (`ALIAS_PAIRS` array, before its closing `];`)
- Test: `src/domain/brewery-aliases.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/brewery-aliases.test.ts`:

```ts
describe('#318 gate-miss alias batch', () => {
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['aecht schlenkerla', 'schlenkerla'],
    ['lausitzer', 'privatbrauerei eibau'],
    ['grybow pilsvar', 'pilsvar'],
    ['cydr dobronski', 'jnt group'],
    ['prerov', 'zubr'],
    ['bakalar', 'tradicni v rakovniku'],
    ['dzik', 'cydrownia'],
    ['panipani', 'trzech kumpli'],
    ['vibrant pour', 'vibrantpour'],
    ['smoothiemaker', 'mad brew'],
    ['drofa', 'дрофа'],
  ];
  test.each(PAIRS)('resolves %s <-> %s symmetrically', (shop, untappd) => {
    expect(aliasNeighbors(shop)).toContain(untappd);
    expect(aliasNeighbors(untappd)).toContain(shop);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/brewery-aliases.test.ts -t "#318"`
Expected: FAIL — none of the new forms are in the neighbour map yet.

- [ ] **Step 3: Append the pairs to `ALIAS_PAIRS`**

In `src/domain/brewery-aliases.ts`, insert these lines immediately before the closing `];` of the `ALIAS_PAIRS` array (after the existing `['jezek kwasnicowy', 'jihlava'],` line):

```ts
  // #318 batch (2026-07-19): live on-tap + shop gate-miss aliases, each verified
  // against the orphan's enrich_failures.candidates_summary (authoritative Untappd
  // brewery) and normalized via `npm run alias-key`.
  ['aecht schlenkerla', 'schlenkerla'],
  ['lausitzer', 'privatbrauerei eibau'],
  ['grybow pilsvar', 'pilsvar'],
  ['cydr dobronski', 'jnt group'],
  ['prerov', 'zubr'],
  ['bakalar', 'tradicni v rakovniku'],
  ['dzik', 'cydrownia'],
  // brand-as-brewery (shop put a beer/brand in the brewery field; confirmed 1:1):
  ['panipani', 'trzech kumpli'],
  ['smoothiemaker', 'mad brew'],
  // shop (extension) sources:
  ['vibrant pour', 'vibrantpour'],
  ['drofa', 'дрофа'],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/brewery-aliases.test.ts -t "#318"`
Expected: PASS (11 cases).

- [ ] **Step 5: Run the whole alias test file (no regression to existing pairs / non-transitivity)**

Run: `npx vitest run src/domain/brewery-aliases.test.ts`
Expected: PASS (existing `aliasNeighbors`/`aliasKeys` tests + the new batch). No new hub is formed (none of the 11 pairs share a canonical form).

- [ ] **Step 6: Commit**

```bash
git add src/domain/brewery-aliases.ts src/domain/brewery-aliases.test.ts
git commit -m "feat(matcher): add #318 gate-miss brewery alias batch (11 pairs)"
```

---

## Task 3: Full verification

- [ ] **Step 1: Full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all tests pass; `tsc --noEmit` clean.

- [ ] **Step 2: Final review**

Confirm: `minipivovar` in `BREWERY_NOISE`; exactly the 11 pairs added (no `měšťanský`/`minibrowar`, no extra pairs); no other files touched; no `spec.md`/`extension/**` changes. Rollout note for the human: after deploy, run `npm run rearm-matcher-bug-orphans` so backed-off orphans re-attempt (not part of this PR).
