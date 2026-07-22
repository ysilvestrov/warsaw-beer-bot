# #295 Search-query noise cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop zero-candidate Untappd searches by deleting non-decimal periods and stripping calendar-year tokens from the enrichment search query only (`cleanSearchQuery`), leaving matching normalization untouched.

**Architecture:** Add one query-only helper `stripQueryTokenNoise` in `src/domain/normalize.ts` and apply it to the cleaned brewery/name strings inside `cleanSearchQuery`. `normalizeName`/`stripSearchNoise` (the shared matching path) are NOT changed, so the brewery gate and name-matching stages are unaffected.

**Tech Stack:** TypeScript, Vitest. Test runner: `npx vitest run <file>`.

**Spec:** `docs/superpowers/specs/2026-07/2026-07-22-issue-295-query-noise-cleanup-design.md`

---

## File Structure

- Modify: `src/domain/normalize.ts` — add `stripQueryTokenNoise`; call it in `cleanSearchQuery` (lines 159–160).
- Modify: `src/domain/normalize.test.ts` — new cases for `stripQueryTokenNoise` + `cleanSearchQuery`; update the one existing year-bearing case (line 198).
- Modify: `src/domain/matcher.test.ts` — regression guard proving matching normalization still matches a `Vol.30`↔`Vol. 30` pair (period-delete did not leak into `normalizeName`).
- Review only: `spec.md` — update the search-query-noise section if it enumerates query cleanups.

---

### Task 1: `stripQueryTokenNoise` helper + wire into `cleanSearchQuery`

**Files:**
- Modify: `src/domain/normalize.ts:158-160`
- Test: `src/domain/normalize.test.ts` (inside the existing `describe('cleanSearchQuery', …)` and a new `describe('stripQueryTokenNoise', …)`)

- [ ] **Step 1: Write the failing tests**

Add a new export to the import on line 1 of `src/domain/normalize.test.ts`:

```ts
import { normalizeName, normalizeBrewery, stripBreweryNoise, stripLegalForm, cleanSearchQuery, stripSearchNoise, stripQueryTokenNoise } from './normalize';
```

Add a new describe block (place it right after the existing `describe('stripSearchNoise', …)` block):

```ts
describe('stripQueryTokenNoise (query-only cleanups)', () => {
  test('deletes a period unless between two digits (glue, do not space)', () => {
    expect(stripQueryTokenNoise('Vol. 30')).toBe('Vol 30');
    expect(stripQueryTokenNoise('D.B.V.S.O.J.')).toBe('DBVSOJ');
    expect(stripQueryTokenNoise('V.S.O.J.')).toBe('VSOJ');
  });
  test('preserves a decimal version/strength token', () => {
    expect(stripQueryTokenNoise('Stópka 3.0')).toBe('Stópka 3.0');
  });
  test('strips a standalone calendar year (19xx/20xx)', () => {
    expect(stripQueryTokenNoise('Vanilla Bean Abraxas 2025')).toBe('Vanilla Bean Abraxas');
    expect(stripQueryTokenNoise('Mineshaft Gap 2026')).toBe('Mineshaft Gap');
  });
  test('keeps a non-year number', () => {
    expect(stripQueryTokenNoise('Pinta 555')).toBe('Pinta 555');
    expect(stripQueryTokenNoise('Many Hops 100')).toBe('Many Hops 100');
  });
});
```

Add these cases inside the existing `describe('cleanSearchQuery', …)` block:

```ts
  test('glues a Vol. period so Algolia can match a glued Vol.30 record (#295)', () => {
    expect(cleanSearchQuery('Upslope', 'Lee Hill Vol. 30 Wild Christmas Ale With Tropical Fruit'))
      .toBe('Upslope Lee Hill Vol 30 Wild Christmas Ale With Tropical Fruit');
  });
  test('glues a dotted abbreviation (#295)', () => {
    expect(cleanSearchQuery('Revolution', 'Peach Brandy Barrel D.B.V.S.O.J.'))
      .toBe('Revolution Peach Brandy Barrel DBVSOJ');
  });
  test('strips a trailing vintage year from the query (#295)', () => {
    expect(cleanSearchQuery('Perennial', 'Vanilla Bean Abraxas 2025'))
      .toBe('Perennial Vanilla Bean Abraxas');
  });
  test('strips a parenthetical vintage year from the query (#295)', () => {
    expect(cleanSearchQuery('Revolution', 'Mineshaft Gap (2026)'))
      .toBe('Revolution Mineshaft Gap');
  });
  test('leaves a clean name unchanged', () => {
    expect(cleanSearchQuery('Almanac', 'Sunshine Sherbet')).toBe('Almanac Sunshine Sherbet');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: FAIL — `stripQueryTokenNoise` is not exported (import error / "is not a function"), and the new `cleanSearchQuery` cases fail (e.g. query still contains `Vol.` / `2025`).

- [ ] **Step 3: Write the implementation**

In `src/domain/normalize.ts`, add the helper immediately above `export function cleanSearchQuery` (before line 158):

```ts
// Query-only token cleanup. NOT used by normalizeName, so matching normalization is unchanged
// (keeping it out of stripSearchNoise is deliberate — see the #295 design doc). Two rules:
//  1. Delete a period unless it sits between two digits: "Vol." -> "Vol", "V.S.O.J." -> "VSOJ",
//     while "3.0" is preserved. Deleting (not spacing) is required — Algolia zeroes "V S O J"
//     but matches "VSOJ"; and a glued Untappd record like "Vol.30" only matches once the query
//     drops the period so the standalone number can align.
//  2. Strip a standalone calendar-year token (19xx/20xx). Algolia ANDs terms and Untappd stores
//     vintages parenthetically, so a bare year over-constrains the search to zero. Mirrors
//     extractYear's year definition; the matcher already treats years as non-identity.
export function stripQueryTokenNoise(s: string): string {
  return s
    .replace(/(?<!\d)\.|\.(?!\d)/g, '')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

Then change lines 159–160 of `cleanSearchQuery` from:

```ts
  const cleanBrewery = stripSearchNoise(stripLegalForm(brewery));
  const cleanName = stripSearchNoise(name);
```

to:

```ts
  const cleanBrewery = stripQueryTokenNoise(stripSearchNoise(stripLegalForm(brewery)));
  const cleanName = stripQueryTokenNoise(stripSearchNoise(name));
```

- [ ] **Step 4: Update the one existing test whose behavior intentionally changes**

In `src/domain/normalize.test.ts`, the case on line 198 used a year to check digit preservation.
Years are now stripped, so switch it to a non-year number (keeps the original intent — digits and
casing survive):

```ts
  test('preserves non-year digits and original casing in surviving tokens', () => {
    expect(cleanSearchQuery('Pinta', 'Many Hops 100')).toBe('Pinta Many Hops 100');
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: PASS (all cases, including the two `stripQueryTokenNoise`/`cleanSearchQuery` describe blocks and the updated line-198 case).

- [ ] **Step 6: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "fix(matcher): #295 strip query-poisoning periods + vintage years from search query"
```

---

### Task 2: Regression guard — matching normalization unchanged

**Files:**
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the guard test**

Confirm the imports at the top of `src/domain/matcher.test.ts` include `matchBeer` (add it to the
existing import from `./matcher` if not present). Then append this test:

```ts
describe('#295 period-delete stays out of matching normalization', () => {
  test('a glued Vol.30 catalog record still matches a shop "Vol. 30" name', () => {
    const catalog = [
      {
        id: 1,
        brewery: 'Upslope Brewing Company',
        name: 'Lee Hill Series Vol.30  Wild Christmas Ale With Tropical Fruit',
        abv: 7.5,
      },
    ];
    const hit = matchBeer(
      { brewery: 'Upslope', name: 'Lee Hill Vol. 30 Wild Christmas Ale With Tropical Fruit', abv: 7.5 },
      catalog,
    );
    expect(hit?.id).toBe(1);
  });
});
```

- [ ] **Step 2: Run the guard test**

Run: `npx vitest run src/domain/matcher.test.ts`
Expected: PASS. (This test is a guard, not red→green: it documents that `normalizeName` was NOT
changed by Task 1, so the shop `Vol. 30` and the glued `Vol.30` still normalize to a fuzzy match
above the local `FUZZY_THRESHOLD` of 0.75.)

- [ ] **Step 3: Commit**

```bash
git add src/domain/matcher.test.ts
git commit -m "test(matcher): #295 guard that period-delete stays out of match normalization"
```

---

### Task 3: Full verification + spec sync

**Files:**
- Review: `spec.md`

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — no regressions across `normalize.test.ts`, `matcher.test.ts`, `untappd-lookup.test.ts`, and the rest.

- [ ] **Step 2: Typecheck / build**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms the lookbehind regex and new export typecheck cleanly.)

- [ ] **Step 3: Check `spec.md` for a search-query-noise section**

Run: `grep -n "cleanSearchQuery\|search query\|stripSearchNoise\|query noise" spec.md`
If a section enumerates the query cleanups, add a line documenting the two #295 cleanups
(non-decimal period deletion; calendar-year strip) as query-only. If no such section exists, no
change is required.

- [ ] **Step 4: Commit any spec change**

```bash
git add spec.md
git commit -m "docs(spec): #295 document query-only period/year cleanups"
```

(Skip this commit if `spec.md` needed no change.)

---

## Ops follow-ups (post-merge, after deploy — NOT part of the code tasks)

1. Deploy: `bash deploy/deploy.sh`.
2. **Re-arm** the stale 0-candidate `matcher_bug` orphans (incl. the Revolution cluster) via
   `rearm-matcher-bug-orphans` (`--ids` exact-id mode, #326/#336). Run after deploy so long-query /
   year / period orphans benefit from the new query.
3. **Verify** on prod DB (read-only) that `31794` (Upslope), `33075` (Perennial), and the
   `D.B.V.S.O.J.`/`V.S.O.J.` Revolution rows now have a non-null `beers.untappd_id`.
4. **Reclassify** `33045 Almanac / Sunshine Sherbet` → `review_class='not_on_untappd'` (Untappd only
   has "Sunset Sherbet"). Leave `32682 Nepomucen / Niunia 2026` (name-divergent candidates).

## PR

Open a PR, wait for the AI review, read + critically assess each comment (verify, push back on wrong
ones, fix valid ones) before merging.
