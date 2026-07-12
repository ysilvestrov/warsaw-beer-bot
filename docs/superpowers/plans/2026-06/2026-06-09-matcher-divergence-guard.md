# Matcher Divergence Guard + Exact-Only Personal Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop false fuzzy matches across flavour variants (reject candidates that diverge on content tokens) and only assert `is_drunk`/personal rating for exact matches.

**Architecture:** Two server-only changes in `src/domain/`. (1) `matchPrepared` rejects a fuzzy candidate whose normalized name diverges from the input — using fuzzy per-token coverage so inflections/typos still match. (2) `matchBeerList` gates `is_drunk`/`user_rating` to `source === 'exact'`; fuzzy still yields `matched_beer` (⭐ global rating). The `/match` response shape is unchanged, so the extension needs no edit.

**Tech Stack:** TypeScript, `fast-fuzzy` (already a dependency; its standalone `fuzzy()`), ts-jest.

**Spec:** `docs/superpowers/specs/2026-06-09-matcher-divergence-guard-design.md`

---

## File structure

| File | Change |
| --- | --- |
| `src/domain/matcher.ts` | import `fuzzy`; add `nameTokensDiverge` + helpers; reject divergent fuzzy candidate in `matchPrepared` |
| `src/domain/matcher.test.ts` | unit tests for `nameTokensDiverge` + integration via `matchBeer` |
| `src/domain/match-list.ts` | gate `is_drunk`/`user_rating` on `m.source === 'exact'` |
| `src/domain/match-list.test.ts` | test fuzzy match never claims drunk/personal |
| `spec.md` | matching-section note |

---

## Task 1: Divergence guard in the matcher

**Files:**
- Modify: `src/domain/matcher.ts`
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/domain/matcher.test.ts`, add `nameTokensDiverge` to the existing import on line 1:

```ts
import { matchBeer, breweryAliases, breweryAliasesMatch, extractYear, prepareCatalog, matchPrepared, prepareBeer, nameTokensDiverge, type CatalogBeer } from './matcher';
```

Then append these two describe blocks to the end of the file:

```ts
describe('nameTokensDiverge', () => {
  test('diverges on different flavour variants', () => {
    expect(nameTokensDiverge('vanilla mind over matter', 's mores mind over matter')).toBe(true);
  });
  test('tolerates a Polish inflection (skejty vs skejta)', () => {
    expect(nameTokensDiverge('buty skejty', 'buty skejta')).toBe(false);
  });
  test('tolerates a typo (chmiel vs chmielu)', () => {
    expect(nameTokensDiverge('atak chmiel', 'atak chmielu')).toBe(false);
  });
  test('subset names do not diverge, either direction', () => {
    expect(nameTokensDiverge('clementine passionfruit', 'clementine')).toBe(false);
    expect(nameTokensDiverge('clementine', 'clementine passionfruit')).toBe(false);
  });
  test('equal names do not diverge', () => {
    expect(nameTokensDiverge('atak chmielu', 'atak chmielu')).toBe(false);
  });
  test('ignores sub-2-char fragments', () => {
    expect(nameTokensDiverge('s mores', 'mores')).toBe(false);
  });
});

describe('matchBeer — divergence guard', () => {
  test('rejects a different flavour variant with no exact entry', () => {
    const cat = [c({ id: 50, brewery: 'Magnify Brewing Company', name: "S'mores Mind Over Matter" })];
    expect(matchBeer({ brewery: 'Magnify', name: 'Double Vanilla Mind Over Matter' }, cat)).toBeNull();
  });
  test('still matches when the input name is a subset of the candidate', () => {
    const cat = [c({ id: 51, brewery: 'Magnify', name: 'Mind Over Matter' })];
    expect(matchBeer({ brewery: 'Magnify', name: 'Vanilla Mind Over Matter' }, cat)?.id).toBe(51);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/domain/matcher.test.ts -t "nameTokensDiverge|divergence guard"`
Expected: FAIL — `nameTokensDiverge` is not exported; the "rejects a different flavour variant" test still returns a match (id 50) instead of null.

- [ ] **Step 3: Implement the guard in `src/domain/matcher.ts`**

Change the import on line 1 to also pull in `fuzzy`:

```ts
import { Searcher, fuzzy } from 'fast-fuzzy';
```

Add these declarations just above `matchPrepared` (after `breweryAliasesMatch`, before `export function matchPrepared`):

```ts
// Per-token similarity floor for the divergence guard. A token is "covered" by the
// other name when some token there scores at least this against it. 0.7 has wide margin:
// Polish inflections / typos score >= 0.83, distinct flavour words <= 0.2.
const TOKEN_SIM = 0.7;

// Drop sub-2-char fragments (e.g. the apostrophe-junk "s" from "s'mores" -> "s mores").
function divergenceTokens(name: string): string[] {
  return name.split(' ').filter((t) => t.length >= 2);
}

function tokenCovered(t: string, others: string[]): boolean {
  return others.some((o) => fuzzy(t, o) >= TOKEN_SIM);
}

// True when each normalized name has a content token the other side does not cover
// (fuzzily) — i.e. the names diverge rather than one being a subset/inflection of the
// other. Rejects fuzzy matches between different flavour variants that share a long base
// name ("vanilla mind over matter" vs "s mores mind over matter").
export function nameTokensDiverge(a: string, b: string): boolean {
  const ta = divergenceTokens(a);
  const tb = divergenceTokens(b);
  const aUncovered = ta.some((t) => !tokenCovered(t, tb));
  const bUncovered = tb.some((t) => !tokenCovered(t, ta));
  return aUncovered && bUncovered;
}
```

Then, in the fuzzy fallback at the end of `matchPrepared`, change:

```ts
  if (!results.length) return null;
  const best = results[0];
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
```

to:

```ts
  if (!results.length) return null;
  const best = results[0];
  // Reject a fuzzy candidate that diverges from the input on content tokens — a
  // different flavour variant of the same base beer (e.g. "Double Vanilla Mind Over
  // Matter" vs "S'mores Mind Over Matter"), which must not inherit drunk/rating data.
  if (nameTokensDiverge(nn, best.item.nameNorm)) return null;
  return { id: best.item.id, confidence: best.score, source: 'fuzzy' };
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx jest src/domain/matcher.test.ts -t "nameTokensDiverge|divergence guard"`
Expected: PASS.

- [ ] **Step 5: Run the full matcher suite (no regressions)**

Run: `npx jest src/domain/matcher.test.ts`
Expected: PASS — including the existing `Buty Skejty`→`Buty Skejta` fuzzy test (the guard tolerates the inflection).

- [ ] **Step 6: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "fix(matcher): reject fuzzy candidates that diverge on content tokens"
```

---

## Task 2: Exact-only personal claims in match-list

**Files:**
- Modify: `src/domain/match-list.ts`
- Test: `src/domain/match-list.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/domain/match-list.test.ts`, add this test inside the first `describe('matchBeerList', ...)` block:

```ts
  it('a fuzzy match never claims drunk or personal rating', async () => {
    // "Atak Chmiel" (typo) fuzzy-matches catalog 200 "Atak Chmielu". Even though 200 is
    // in the drunk set with a rating, a fuzzy match must not assert drunk/personal.
    const res = await matchBeerList(
      catalog,
      new Set([200]),
      new Map([[200, 4.5]]),
      [{ brewery: 'PINTA', name: 'Atak Chmiel' }],
    );
    expect(res[0].matched_beer?.id).toBe(200);
    expect(res[0].is_drunk).toBe(false);
    expect(res[0].user_rating).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/domain/match-list.test.ts -t "never claims drunk"`
Expected: FAIL — `is_drunk` is `true` (200 is in the drunk set) because gating isn't implemented yet.

- [ ] **Step 3: Gate the claims in `src/domain/match-list.ts`**

In the matched branch where `matched_beer` is built, change:

```ts
        is_drunk: drunkSet.has(m.id),
        user_rating: ratingByBeerId.get(m.id) ?? null,
```

to:

```ts
        is_drunk: m.source === 'exact' && drunkSet.has(m.id),
        user_rating: m.source === 'exact' ? (ratingByBeerId.get(m.id) ?? null) : null,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/domain/match-list.test.ts -t "never claims drunk"`
Expected: PASS.

- [ ] **Step 5: Run the full match-list suite (no regressions)**

Run: `npx jest src/domain/match-list.test.ts`
Expected: PASS — the existing exact-match drunk test (id 105, `is_drunk: true`, `user_rating: 4.0`) still passes (exact matches are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "fix(match): assert is_drunk/personal rating only for exact matches"
```

---

## Task 3: Spec note

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Update `spec.md` matching section**

Run `grep -n "fuzzy\|FUZZY\|matchBeer\|is_drunk\|matched_beer" spec.md` to locate the matching/`/match` description. In the section that describes the matcher / `/match` semantics, add a sentence:

```markdown
Fuzzy-кандидат відхиляється, якщо нормалізована назва розходиться з інпутом по
контентних токенах (різні смакові варіанти одного базового пива — fuzzy-покриття
токенів, тож відмінки/опечатки лишаються матчем). `is_drunk` і особиста оцінка в
`/match` проставляються лише для **exact**-матчів; fuzzy-матч дає тільки глобальний
рейтинг.
```

Place it adjacent to the existing matching/`/match` description (pick the closest matching bullet/paragraph from the grep output). If `spec.md` has no matching/`/match` description to attach to, add the sentence under the Browser Extension / `/match` section.

- [ ] **Step 2: Commit**

```bash
git add spec.md
git commit -m "docs(spec): note divergence guard + exact-only drunk/personal claims"
```

---

## Task 4: Full verification

- [ ] **Step 1: Full bot suite**

Run: `npm test`
Expected: all bot/jest suites green, including the updated `matcher` and `match-list` tests and the unchanged `api/routes/match` test.

- [ ] **Step 2: Extension suite (unaffected, confirm still green)**

Run: `cd extension && npm test && npm run typecheck`
Expected: all vitest suites green; `tsc --noEmit` exits 0. (No extension files changed; this confirms the `/match` contract is unchanged.)

---

## Self-review notes

- **Spec coverage:** divergence guard with fuzzy token coverage (Task 1), exact-only `is_drunk`/`user_rating` gating (Task 2), fuzzy still yields `matched_beer`/⭐ (Task 2 — `matched_beer` unchanged), no response-shape/extension change (no extension task; Task 4 Step 2 confirms), spec note (Task 3). All spec sections map to a task.
- **Type consistency:** `nameTokensDiverge(a: string, b: string): boolean` used identically in matcher and tests; `matchPrepared`'s `MatchResult.source` (`'exact' | 'fuzzy'`) drives the Task 2 gate; `TOKEN_SIM = 0.7`.
- **No placeholders:** every code/command step is complete; both integration test expectations were verified against the live matcher (FP → id 50 @ 0.781 pre-guard; subset → id 51 @ 0.75).
- **Execution note:** implement in a worktree (branches from `origin/main`); cherry-pick the spec commits (`e36f28d`, `bd61e32`) and this plan's commit into the worktree branch, per project convention.
```
