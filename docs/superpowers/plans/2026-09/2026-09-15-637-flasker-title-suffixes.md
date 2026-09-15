# Flasker title suffixes (#637) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match Flasker Imperial Stouts and vintage editions using the beer names published on Untappd, without changing any other shop's parser.

**Architecture:** Keep the existing earliest-marker rule for finding the leading brewery/name head. When an ABV marker precedes package volume, retain only the trimmed text between them as a name qualifier; the ABV matcher consumes an optional literal `ABV` so it cannot become a qualifier. Then remove Flasker's terminal Imperial-Stout shorthand `IS` at the adapter boundary, preserving only the exact genuine name `LOVE IS`.

**Tech Stack:** TypeScript 7, Vitest 5, jsdom 30, browser extension adapter tests.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-15-637-flasker-title-suffixes-design.md`

## Global Constraints

- Scope is restricted to the Flasker adapter, its tests, `spec.md`, its user-facing changelog, and the Ukrainian installation guide.
- Do not change `normalizeName`, the server matcher, API payload types, cache keys, database rows, manifest permissions, dependencies, or other shop adapters.
- Do not mutate production data; the production-catalogue inspection is evidence only.
- Preserve exactly `LOVE IS`, case-insensitively; every other terminal standalone `IS` emitted by Flasker is removed.
- Preserve text only after ABV and before a later package-volume marker. Do not retain text after package volume or create a tail when volume is first or missing.
- Follow RED → GREEN: observe each focused new test fail before changing production code.
- After each task run both package gates: `npm test && npm run typecheck` and `npm --prefix extension test && npm --prefix extension run typecheck`.
- `extension/CHANGELOG.md` is user-facing: one `[Unreleased]` entry, no code vocabulary or testing notes.

## File Structure

| File | Responsibility |
|---|---|
| `extension/src/sites/flasker.ts` | Parse Flasker title head, identity tail and terminal style shorthand. |
| `extension/src/sites/flasker.test.ts` | Regression tests at the adapter boundary for published title → match payload identity. |
| `spec.md` | State Flasker's revised title-boundary and `IS` exception contract. |
| `extension/CHANGELOG.md` | Tell extension users that affected Flasker badges now appear. |
| `docs/extension-install-uk.md` | Explain that Flasker title qualifiers are retained for accurate matching. |

---

### Task 1: Parse identity text and Imperial Stout shorthand

**Files:**
- Modify: `extension/src/sites/flasker.ts:8-12,286-326`
- Test: `extension/src/sites/flasker.test.ts:92-110,120-145`

**Interfaces:**
- Consumes: `volumeIndex(title)`, `ABV_RE`, existing brewery resolution, and `stripMerchandisingPrefix(name)`.
- Produces: unchanged `parseTitle(rawTitle, evidence): { brewery: string; name: string; abv?: number } | null`, but with a precise `name` suitable for `/match`.

- [ ] **Step 1: Write failing regression tests**

  Add these cases within `describe('parseTitle')`, replacing the current Xmas Eve expectation that documents the loss of `[2025]`:

  ```ts
  it('keeps a vintage written after ABV and before the package volume', () => {
    expect(parseTitle('The Lost Philosopher Xmas Eve 10% [2025] 0.75л', {
      productTags: ['mad brew'],
    })).toEqual({ brewery: 'Mad Brew', name: 'The Lost Philosopher Xmas Eve [2025]', abv: 10 });
  });

  it('does not retain an ABV label as identity text', () => {
    expect(parseTitle('LEFFE BLONDE 6.6% ABV 0.33л'))
      .toEqual({ brewery: 'LEFFE', name: 'BLONDE', abv: 6.6 });
  });

  it('removes Flasker’s terminal Imperial Stout shorthand', () => {
    expect(parseTitle('VARVAR BLACK BEAN IS 11% 0.33л'))
      .toEqual({ brewery: 'VARVAR', name: 'BLACK BEAN', abv: 11 });
    expect(parseTitle('Vibrant Pour CherryEmber IS 8% 330ml', {
      productTags: ['vibrant pour'],
    })).toEqual({ brewery: 'VibrantPour', name: 'CherryEmber', abv: 8 });
  });

  it('preserves the only verified genuine terminal IS name', () => {
    expect(parseTitle('REBREW LOVE IS 8% 330ml', { productTags: ['rebrew'] }))
      .toEqual({ brewery: 'Rebrew', name: 'LOVE IS', abv: 8 });
  });
  ```

  Update the four existing terminal-`IS` expectations as part of the same RED
  step, so the former expected values no longer silently document the defect:

  ```ts
  // `Hoppy Hog Charred Memory IS …` occurs twice in the current file.
  { brewery: 'Hoppy Hog Family Brewery', name: 'Charred Memory', abv: 10 }

  // `ПРЕДРЕЛІЗ: Morava Winter Flow IS …` and the AOTEAROA variant.
  { brewery: 'VibrantPour', name: 'Morava Winter Flow', abv: 10 }
  ```

- [ ] **Step 2: Verify RED**

  Run:

  ```bash
  npm --prefix extension test -- src/sites/flasker.test.ts
  ```

  Expected: FAIL because the current parser returns `Xmas Eve` without `[2025]`, leaves `IS` in `BLACK BEAN IS` and `CherryEmber IS`, and treats `ABV` as tail text once the new test exposes the intended contract.

- [ ] **Step 3: Add the narrow parsing helpers and connect them to `parseTitle`**

  In `extension/src/sites/flasker.ts`, replace the ABV expression with one that consumes the optional label without changing capture group 1:

  ```ts
  const ABV_RE = /(\d+(?:[.,]\d+)?)\s*%(?:\s*ABV)?/iu;
  ```

  Add the adapter-local helper beside `stripMerchandisingPrefix`:

  ```ts
  const GENUINE_TERMINAL_IS_NAME_RE = /^love is$/iu;
  const TERMINAL_IMPERIAL_STOUT_RE = /\s+IS$/iu;

  function stripFlaskerImperialStoutSuffix(name: string): string {
    const trimmed = name.trim();
    if (GENUINE_TERMINAL_IS_NAME_RE.test(trimmed)) return trimmed;
    return trimmed.replace(TERMINAL_IMPERIAL_STOUT_RE, '').trim();
  }
  ```

  In `parseTitle`, retain the leading head calculation. Directly after it, compute only the allowed post-ABV span:

  ```ts
  const tailStart = abvMatch && abvAt >= 0 ? abvAt + abvMatch[0].length : -1;
  const identityTail = tailStart >= 0 && volAt > tailStart
    ? title.slice(tailStart, volAt).trim()
    : '';
  ```

  Replace the final name construction with this sequence after brewery resolution:

  ```ts
  const nameHead = stripMerchandisingPrefix(nameBeforeCleanup);
  const name = stripFlaskerImperialStoutSuffix(
    [nameHead, identityTail].filter(Boolean).join(' '),
  );
  ```

  Do not alter the fallback splitting, registry, detail hydration, or any cache behavior.

- [ ] **Step 4: Verify GREEN**

  Re-run:

  ```bash
  npm --prefix extension test -- src/sites/flasker.test.ts
  ```

  Expected: PASS. Confirm from the assertion output that final `IS` is absent for `BLACK BEAN`, `CherryEmber`, existing Hoppy Hog and Morava tests, while `LOVE IS` remains exact.

- [ ] **Step 5: Run the full gates**

  ```bash
  npm test && npm run typecheck
  npm --prefix extension test && npm --prefix extension run typecheck
  ```

  Expected: all tests and both TypeScript checks pass. If any pre-existing failure appears, stop and record it separately rather than weakening this regression coverage.

- [ ] **Step 6: Commit the parser and tests**

  ```bash
  git add extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts
  git commit -m "fix(extension): preserve Flasker title identity"
  ```

### Task 2: Publish the revised Flasker contract

**Files:**
- Modify: `spec.md:2500-2525`
- Modify: `extension/CHANGELOG.md:24-27`
- Modify: `docs/extension-install-uk.md:170-178`

**Interfaces:**
- Consumes: the verified `parseTitle` contract from Task 1 and its five regression cases.
- Produces: user and project documentation that describes the same parser behavior the tests prove.

- [ ] **Step 1: Update the OpenSpec adapter contract**

  In the Flasker paragraph of `spec.md`, replace the sentence:

  ```text
  найраніший volume або ABV-маркер задає межу brewery/name;
  ```

  with a sentence that keeps the existing head boundary but makes the new rule explicit:

  ```text
  найраніший volume або ABV-маркер задає межу head для brewery/name; коли ABV стоїть раніше за package-volume, текст між ними додається до name як identity-qualifier (наприклад `[2025]`), а текст після package-volume не входить до name. Flasker-скорочення terminal `IS` (Imperial Stout) знімається на adapter boundary; єдиний виміряний виняток — точна назва `LOVE IS` від Rebrew.
  ```

  Preserve the adjacent classification-only and hydration rules unchanged.

- [ ] **Step 2: Add one user-facing changelog entry**

  Under `## [Unreleased]` in `extension/CHANGELOG.md`, add exactly this entry before the current non-beer entry:

  ```markdown
  - Fixed Flasker Imperial Stouts and vintage editions showing no badge when the shop shortened the style to “IS” or put the year after the strength. Their usual rating or drinking-status badge now appears.
  ```

- [ ] **Step 3: Update the Ukrainian installation guide**

  Append this sentence to the existing Flasker note in Part 3, step 4, after the paragraph about the shop's published Untappd link:

  ```text
  Розширення також зберігає рік видання та прибирає скорочення стилю з назви Flasker, тож бейдж не губиться для вінтажів і Imperial Stout.
  ```

- [ ] **Step 4: Inspect the documentation diff**

  ```bash
  git diff --check
  git diff -- spec.md extension/CHANGELOG.md docs/extension-install-uk.md
  ```

  Expected: the wording matches the Task 1 behavior, uses no implementation vocabulary in user-facing files, and leaves unrelated installation and badge material unchanged.

- [ ] **Step 5: Re-run the full gates**

  ```bash
  npm test && npm run typecheck
  npm --prefix extension test && npm --prefix extension run typecheck
  ```

  Expected: all commands pass; documentation must not mask a parser regression.

- [ ] **Step 6: Commit the contract and user documentation**

  ```bash
  git add spec.md extension/CHANGELOG.md docs/extension-install-uk.md
  git commit -m "docs: describe Flasker title matching"
  ```

### Task 3: Whole-branch review and delivery readiness

**Files:**
- Review: the complete `fix-637-flasker-title` branch relative to `origin/main`

**Interfaces:**
- Consumes: the Task 1 parser behavior, Task 2 documentation contract, full test-gate output, and issue #637 evidence.
- Produces: a review receipt or narrowly scoped corrective follow-up before pull-request preparation.

- [ ] **Step 1: Check the branch scope**

  ```bash
  git diff --check origin/main...HEAD
  git diff --stat origin/main...HEAD
  git diff origin/main...HEAD -- extension/src/sites/flasker.ts extension/src/sites/flasker.test.ts spec.md extension/CHANGELOG.md docs/extension-install-uk.md
  ```

  Expected: only the design document plus the five files declared in this plan differ; no production-data files, server code, dependencies, or manifest files are present.

- [ ] **Step 2: Request a diff-scoped code review**

  Invoke `compound-engineering:ce-code-review` for the branch diff against `origin/main`. Supply the #637 acceptance cases: drop all terminal Flasker `IS` except exact `LOVE IS`; preserve `[2025]` only between ABV and package volume; preserve existing adapter, API and cache contracts.

- [ ] **Step 3: Resolve valid review findings one at a time**

  For every valid finding, add or strengthen the closest `flasker.test.ts` regression first, observe it fail, make the smallest parser/documentation change, and repeat both full gates. Do not broaden scope for stylistic or speculative suggestions.

- [ ] **Step 4: Record the final verification**

  ```bash
  git status --short
  npm test && npm run typecheck
  npm --prefix extension test && npm --prefix extension run typecheck
  ```

  Expected: clean status and four passing commands. Save their command output in the delivery summary; do not claim success from an earlier run.
