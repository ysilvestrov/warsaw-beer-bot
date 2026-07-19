# `family` brewery noise + `Series:` query-label strip (#309 + #303) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two small matcher-query normalisation fixes so `family`-suffixed breweries match and `Series:` collection labels stop zeroing the Untappd search.

**Architecture:** Both live in `src/domain/normalize.ts`. #309 adds one token to the `BREWERY_NOISE` set (dropped from brewery tokens in both `normalizeBrewery` and the query builder). #303 adds one regex to `stripSearchNoise` (shared by query + match normalisation) that removes a leading label run ending in the word `series` + a separator.

**Tech Stack:** TypeScript, Vitest. Design doc: `docs/superpowers/specs/2026-07/2026-07-19-matcher-family-noise-series-labels-design.md`.

---

## File Structure

- `src/domain/normalize.ts` — `BREWERY_NOISE` set (add `'family'`); `stripSearchNoise` (add the `series`-label strip).
- `src/domain/normalize.test.ts` — new tests for both.

Both changes are additive and independent; each is its own task + commit.

**Repo conventions:** run a single test file with `npx vitest run src/domain/normalize.test.ts`. Follow the existing test style in that file (bare `test(...)`/`expect` and `describe(...)` blocks). `stripSearchNoise`, `cleanSearchQuery`, `normalizeBrewery`, `BREWERY_NOISE` are all exported and already imported in the test file.

---

## Task 1: #309 — `family` as brewery noise

**Files:**
- Modify: `src/domain/normalize.ts` (the `BREWERY_NOISE` set, ends at the `'nanobrowar', 'nanobrowary', 'nanobryggeri',` line)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/normalize.test.ts`:

```ts
describe("'family' brewery noise (#309)", () => {
  test('family is dropped so X Family Brewery == X Brewery', () => {
    expect(normalizeBrewery('HOPPY HOG FAMILY BREWERY')).toBe('hoppy hog');
    expect(normalizeBrewery('Hoppy Hog Family Brewery')).toBe('hoppy hog');
    expect(normalizeBrewery('HOPPY HOG BREWERY')).toBe('hoppy hog');
  });
  test('family is dropped from the search query brand tokens', () => {
    expect(cleanSearchQuery('Hoppy Hog Family Brewery', 'Pale Ale')).toBe('Hoppy Hog Pale Ale');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/normalize.test.ts -t "family"`
Expected: FAIL — `normalizeBrewery('HOPPY HOG FAMILY BREWERY')` returns `'hoppy hog family'`, not `'hoppy hog'`.

- [ ] **Step 3: Add `family` to `BREWERY_NOISE`**

In `src/domain/normalize.ts`, change the last line of the `BREWERY_NOISE` set from:

```ts
  'nanobrowar', 'nanobrowary', 'nanobryggeri',
]);
```

to:

```ts
  'nanobrowar', 'nanobrowary', 'nanobryggeri',
  // Descriptor in "<brand> Family Brewery"; never the load-bearing brand token (#309).
  'family',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/normalize.test.ts -t "family"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(matcher): treat 'family' as brewery noise (#309)"
```

---

## Task 2: #303 — strip a `Series` label prefix

**Files:**
- Modify: `src/domain/normalize.ts` (`stripSearchNoise`)
- Test: `src/domain/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/normalize.test.ts`:

```ts
describe("Series: label strip (#303)", () => {
  test('strips a leading "<label> Series:" prefix, keeping the tail', () => {
    expect(stripSearchNoise('Crazy Lines Series: Redwood')).toBe('Redwood');
    expect(stripSearchNoise('Gold Series: Blast')).toBe('Blast');
    expect(stripSearchNoise('WORLD CUP SERIES - 5 SPECIAL BEER')).toBe('5 SPECIAL BEER');
  });
  test('drops the Series label from the built search query', () => {
    expect(cleanSearchQuery('Nepomucen', 'Crazy Lines Series: Redwood')).toBe('Nepomucen Redwood');
  });
  test('negative guard: leaves names without a series label untouched', () => {
    expect(stripSearchNoise('Time Series IPA')).toBe('Time Series IPA'); // no separator after "series"
    expect(stripSearchNoise('Double Dry Hopped Galaxy')).toBe('Double Dry Hopped Galaxy');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/normalize.test.ts -t "Series"`
Expected: FAIL — `stripSearchNoise('Crazy Lines Series: Redwood')` returns the full string (label not stripped).

- [ ] **Step 3: Add the `series`-label strip to `stripSearchNoise`**

In `src/domain/normalize.ts`, the `stripSearchNoise` function begins:

```ts
export function stripSearchNoise(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, ' ')                     // [adjunct, lists]
```

Insert the series-label strip as the **first** replacement in the chain, so it runs on the raw string:

```ts
export function stripSearchNoise(s: string): string {
  return s
    // Drop a leading "<label> Series:" collection prefix that otherwise ANDs the
    // Algolia query to zero hits (#303). Anchored on the word "series" + a
    // separator, so names without a labelled series ("Time Series IPA") are kept.
    .replace(/^.*?\bseries\b\s*[:\-–—]\s*/iu, '')
    .replace(/\[[^\]]*\]/g, ' ')                     // [adjunct, lists]
```

(Leave the rest of the function unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/normalize.test.ts -t "Series"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(matcher): strip leading 'Series:' label from search query (#303)"
```

---

## Task 3: Full verification

- [ ] **Step 1: Run the whole normalize suite (no regression)**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: all pass (existing noise-strip, diacritics, nano-noise, multilingual tests + the 5 new tests).

- [ ] **Step 2: Run the full suite + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: all tests pass; `tsc --noEmit` clean.

- [ ] **Step 3: Final review**

Confirm: `'family'` in `BREWERY_NOISE`; the `series`-strip is the first replacement in `stripSearchNoise`; no other files touched; no `spec.md`/`extension/**` changes needed (matcher-only, server-side).
