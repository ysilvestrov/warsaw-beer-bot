# Flasker Morava Family Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Flasker `Morava` series listings to `VibrantPour` without dropping the `Morava` name token, then safely release issue #376's retry cohort while keeping its imported-beer row locked to #307.

**Architecture:** Extend the existing Flasker product-family slug mechanism rather than changing the generic title splitter or detail hydration. A `morava-` slug selects the existing `VibrantPour` rule before fallback splitting, producing `VibrantPour / Morava …` even when tags and bounded detail fetching are unavailable.

**Tech Stack:** TypeScript, Vitest, Chrome extension site adapters, SQLite orphan-triage state.

**Spec:** `spec.md` §6 Flasker adapter behavior and GitHub issue #376.

## Global Constraints

- Preserve the existing adapter resolution order: curated slug rules, tags, generated registry, then fallback.
- Add no dependency or new abstraction.
- Update the extension changelog and `spec.md` with the behavior change.
- Keep `review_class` unchanged when remapping production rows.
- Remap only explicitly verified beer IDs; never bulk-update all rows owned by #376.

---

### Task 1: Resolve the Morava family and prepare #376 for retry

**Files:**
- Modify: `extension/src/sites/flasker.test.ts`
- Modify: `extension/src/sites/flasker.ts`
- Modify: `extension/CHANGELOG.md`
- Modify: `spec.md`

**Interfaces:**
- Consumes: `parseTitle(rawTitle, { productUrl })` and the existing `BreweryRule.familySlugPrefixes` resolution path.
- Produces: `{ brewery: 'VibrantPour', name: 'Morava Winter Flow IS', abv: 10 }` for a banner-prefixed `morava-` product URL.

- [x] **Step 1: Write the failing regression test**

```ts
it('resolves the Morava series to VibrantPour without dropping the series name', () => {
  expect(parseTitle('ПРЕДРЕЛІЗ: Morava Winter Flow IS 10% 0.33', {
    productUrl: 'https://flasker.com.ua/product/предреліз-morava-winter-flow-is-10-0-33/',
  })).toEqual({ brewery: 'VibrantPour', name: 'Morava Winter Flow IS', abv: 10 });
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/sites/flasker.test.ts -t "resolves the Morava series"`

Expected: FAIL because the current fallback returns `Morava / Winter Flow IS`.

- [x] **Step 3: Add the minimal family slug rule**

Add `familySlugPrefixes: ['morava-']` to the existing `VibrantPour` entry in `BREWERY_RULES`. Do not alter fallback splitting or detail hydration.

- [x] **Step 4: Verify GREEN and the adjacent adapter suite**

Run: `npm test -- src/sites/flasker.test.ts -t "resolves the Morava series"`

Expected: one passing regression test.

Run: `npm test -- src/sites/flasker.test.ts`

Expected: all Flasker adapter tests pass.

- [x] **Step 5: Document the behavior**

Add one outcome-oriented bullet under `extension/CHANGELOG.md` `[Unreleased]`. Update the Flasker product-family sentence in `spec.md` to name Morava → VibrantPour alongside the existing Mad Brew families.

- [x] **Step 6: Run full extension verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all commands exit 0.

- [x] **Step 7: Remap the imported row after code verification**

Run an explicit production update for beer 34250 only:

```sql
UPDATE enrich_failures SET issue_number = 307 WHERE beer_id = 34250 AND issue_number = 376;
```

Read the row back in read-only mode and confirm `review_class` is unchanged. Leave the remaining #376 cohort on #376 so closing it grants the intended post-fix retry.

- [x] **Step 8: Review the diff and prepare handoff**

Run: `git diff --check`

Run: `git status --short`

Confirm only the four documented files plus this plan belong to the fix.
