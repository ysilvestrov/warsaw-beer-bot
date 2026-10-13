# Fest Target by Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A festival beer nobody in the team has had becomes a Target when its name carries one of the festival's name patterns.

**Architecture:** One JSON column on `fests` (default `'[]'`), one more criterion and reason in the pure `computeTargets`, one label. No value is seeded; the operator sets it.

**Tech Stack:** TypeScript, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-13-fest-target-name-patterns-design.md`

## Global Constraints

- Full gate: `npm test && npm run typecheck`. Tests only through `npm test -- <args>`.
- Test quality: exact asserts, no conditionals, literal expected values.
- The migration is expand-only: `ALTER TABLE fests ADD COLUMN target_name_patterns TEXT NOT NULL DEFAULT '[]';` — no `UPDATE`.
- Reason order: `rating`, `style`, `abv`, `name`, `manual`.
- The name pattern is looked for in `beers.name` only; a blank pattern is ignored.
- `spec.md` is updated in the same PR.

---

### Task 1: the rule, end to end (inline: complete code, one concept)

**Files:**
- Modify: `src/storage/schema.ts` (v49), `src/storage/fests.ts` (`Fest.target_name_patterns`, parsed in `toFest`)
- Modify: `src/domain/fest/targets.ts`, `src/jobs/fest-view.ts`
- Modify: `src/bot/commands/fest-format.ts`, `src/i18n/types.ts`, `src/i18n/locales/{uk,pl,en}.ts`
- Test: `src/domain/fest/targets.test.ts`, `src/storage/fests.test.ts`, `src/storage/schema.test.ts`, `src/jobs/fest-view.test.ts`, `src/bot/commands/fest-format.test.ts`
- Modify: `spec.md`

- [ ] **Step 1: failing tests** in `targets.test.ts`:

```ts
it('a festival special with no rating is a Target by name; its neighbour stays unrated', () => {
  const plain = named(2, 'Hyperjuice Mango');
  expect(runName([named(1, '8. HYPERJUICE WFP 22'), plain])).toEqual({
    targets: [{ beerId: 1, section: 'Green Head', reasons: ['name'], rating: null, style: 'Lager - Pale' }],
    unrated: [plain],
  });
});
```

plus: case-insensitive both ways; any of several patterns; a pattern present only in section and style does not match; no patterns — no reason; blank patterns (`''`, `'  '`) ignored and `' WFP '` trimmed; reason order with all four automatic reasons and a manual add; a tried special is not a Target; a manual remove drops it.

- [ ] **Step 2: run** `npm test -- src/domain/fest/targets.test.ts` — fails on the missing criterion.

- [ ] **Step 3: implement**

```ts
const namePatterns = input.criteria.namePatterns.map((p) => p.trim().toLowerCase()).filter((p) => p !== '');
// …
const name = item.name.toLowerCase();
if (untried && namePatterns.some((p) => name.includes(p))) reasons.push('name');
```

between the strength and the manual reason; `toFest` parses `target_name_patterns`; `buildFestView` passes `namePatterns: fest.target_name_patterns`; `reasonsLabel` maps `'name'` to `fest.reason_name` (`🎪 фестивальне` / `🎪 festiwalowe` / `🎪 festival special`).

- [ ] **Step 4: mutation** — drop the blank-pattern filter; drop `untried`; match against the style instead of the name; each must fail a named test; restore.

- [ ] **Step 5:** the two rewinding helpers in `schema.test.ts` drop the new column; `spec.md`; full gate; commit.
