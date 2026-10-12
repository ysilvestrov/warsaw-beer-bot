# Fest Target by ABV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A festival beer nobody in the team has had becomes a Target when its ABV reaches the festival's threshold.

**Architecture:** One nullable column on `fests`, one more criterion and reason in the pure `computeTargets`, one label. No value is seeded; the operator sets it.

**Tech Stack:** TypeScript, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-13-fest-target-min-abv-design.md`

## Global Constraints

- Full gate: `npm test && npm run typecheck`. Tests only through `npm test -- <args>`.
- Test quality: exact asserts, no conditionals, literal expected values.
- The migration is expand-only: `ALTER TABLE fests ADD COLUMN target_min_abv REAL;` — no `UPDATE`.
- Reason order: `rating`, `style`, `abv`, `manual`.
- `spec.md` is updated in the same PR.

---

### Task 1: the rule, end to end (inline: complete code, one concept)

**Files:**
- Modify: `src/storage/schema.ts` (v48), `src/storage/fests.ts` (`Fest.target_min_abv`)
- Modify: `src/domain/fest/targets.ts`, `src/jobs/fest-view.ts`
- Modify: `src/bot/commands/fest-format.ts`, `src/i18n/types.ts`, `src/i18n/locales/{uk,pl,en}.ts`
- Test: `src/domain/fest/targets.test.ts`, `src/storage/fests.test.ts`, `src/storage/schema.test.ts`, `src/jobs/fest-view.test.ts`, `src/bot/commands/fest-format.test.ts`
- Modify: `spec.md`

- [ ] **Step 1: failing tests** in `targets.test.ts`:

```ts
it('an ABV of 7.9 misses the bar, 8.0 meets it', () => {
  const { targets } = runAbv([item(1, null, 'IPA - Belgian', 'PINTA', 7.9), item(2, null, 'IPA - Belgian', 'PINTA', 8)]);
  expect(targets.map((t) => [t.beerId, t.reasons])).toEqual([[2, ['abv']]]);
});
```

plus: unknown ABV (`null`, `0`) stays in `unrated`; `minAbv: null` gives no `abv` reason to a 12% beer; all three reasons combine in order; a tried strong beer is not a Target; a manual remove drops it.

- [ ] **Step 2: run** `npm test -- src/domain/fest/targets.test.ts` — fails on the missing criterion.

- [ ] **Step 3: implement**

```ts
if (untried && input.criteria.minAbv !== null && item.abv !== null && item.abv >= input.criteria.minAbv) reasons.push('abv');
```

between the style and the manual reason; `Fest.target_min_abv: number | null`; `buildFestView` passes `minAbv: fest.target_min_abv`; `reasonsLabel` maps `'abv'` to `fest.reason_abv` (`💪 міцне` / `💪 mocne` / `💪 strong`).

- [ ] **Step 4: mutation** — drop the `>=` to `>`, then drop the `minAbv !== null` guard; each must fail a named test; restore.

- [ ] **Step 5:** `spec.md`, full gate, commit.
