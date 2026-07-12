# ABV Open-Ended Thresholds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the closed single-select ABV bands (`≤5% / 5–7% / 7–9% / 9%+`) with open-ended threshold presets (`≤3.5% / ≤5% / 5%+ / 7%+ / 9%+`, two-row layout) so "only strong" / "only light" is expressible in one tap, and show stale stored ranges honestly.

**Architecture:** Rename `ABV_BUCKETS`→`ABV_PRESETS` in `domain/filters.ts` with the 5 new open-ended presets; `bucketForRange` is unchanged in logic (exact `(min,max)` match for the ✓). A new pure `formatAbvRange(min,max)` drives the summary line from the raw stored range (so a leftover `5–7%` shows honestly rather than silently filtering). The keyboard splits the ABV row into caps (`max!=null`) and floors (`min!=null`). `filterInteresting` is untouched — it already honors `abv_min`/`abv_max`.

**Tech Stack:** Node.js ≥20, TypeScript (strict), Telegraf, Jest. Tests: `npx jest`, types: `npm run typecheck`.

**Design reference:** `docs/superpowers/specs/2026-06-03-abv-open-ended-thresholds-design.md`

---

## File Structure

- **Modify** `src/domain/filters.ts` — rename `AbvBucket`→`AbvPreset`, `ABV_BUCKETS`→`ABV_PRESETS` (5 presets); add `formatAbvRange`. `bucketForRange` logic unchanged.
- **Modify** `src/domain/filters.test.ts` — update preset + `bucketForRange` tests; add `formatAbvRange` tests.
- **Modify** `src/bot/keyboards.ts` — rename import; split ABV into two rows.
- **Modify** `src/bot/keyboards.test.ts` — update ABV keys; assert two-row layout.
- **Modify** `src/bot/commands/filters.ts` — rename import; summary uses `formatAbvRange`.
- **Modify** `spec.md` — §3.9, §4 `/filters`.

---

## Task 1: rename to `ABV_PRESETS` + 5 open-ended presets

**Files:**
- Modify: `src/domain/filters.ts:43-60`
- Modify: `src/domain/filters.test.ts`
- Modify: `src/bot/keyboards.ts:3,35-37`
- Modify: `src/bot/commands/filters.ts:7,26,74`
- Modify: `src/bot/keyboards.test.ts:38-39`

- [ ] **Step 1: Update the filters test (presets + bucketForRange)**

In `src/domain/filters.test.ts`, change the import:

```typescript
import { filterInteresting, rankByRating, topStyleFamilies, ABV_BUCKETS, bucketForRange } from './filters';
```

to:

```typescript
import { filterInteresting, rankByRating, topStyleFamilies, ABV_PRESETS, bucketForRange } from './filters';
```

Replace the `ABV_BUCKETS` test:

```typescript
test('ABV_BUCKETS are the four agreed single-select ranges', () => {
  expect(ABV_BUCKETS.map((b) => b.key)).toEqual(['0-5', '5-7', '7-9', '9plus']);
  expect(ABV_BUCKETS.map((b) => [b.min, b.max])).toEqual([
    [null, 5], [5, 7], [7, 9], [9, null],
  ]);
});
```

with:

```typescript
test('ABV_PRESETS are the open-ended threshold presets', () => {
  expect(ABV_PRESETS.map((b) => b.key)).toEqual(['lte3_5', 'lte5', 'gte5', 'gte7', 'gte9']);
  expect(ABV_PRESETS.map((b) => [b.min, b.max])).toEqual([
    [null, 3.5], [null, 5], [5, null], [7, null], [9, null],
  ]);
});
```

Replace the `bucketForRange` test:

```typescript
test('bucketForRange maps an exact (min,max) pair to its key, else null', () => {
  expect(bucketForRange(null, 5)).toBe('0-5');
  expect(bucketForRange(5, 7)).toBe('5-7');
  expect(bucketForRange(9, null)).toBe('9plus');
  expect(bucketForRange(null, null)).toBeNull();
  expect(bucketForRange(4, 6)).toBeNull();
});
```

with:

```typescript
test('bucketForRange maps an exact (min,max) pair to its preset key, else null', () => {
  expect(bucketForRange(null, 3.5)).toBe('lte3_5');
  expect(bucketForRange(null, 5)).toBe('lte5');
  expect(bucketForRange(5, null)).toBe('gte5');
  expect(bucketForRange(7, null)).toBe('gte7');
  expect(bucketForRange(9, null)).toBe('gte9');
  expect(bucketForRange(5, 7)).toBeNull(); // stale old band
  expect(bucketForRange(7, 9)).toBeNull(); // stale old band
  expect(bucketForRange(null, null)).toBeNull();
});
```

- [ ] **Step 2: Run the filters test to verify it fails**

Run: `npx jest src/domain/filters.test.ts -t ABV_PRESETS`
Expected: FAIL — `ABV_PRESETS` is not exported.

- [ ] **Step 3: Rename + new presets in `filters.ts`**

In `src/domain/filters.ts`, replace:

```typescript
export interface AbvBucket {
  key: string;
  label: string;
  min: number | null;
  max: number | null;
}

export const ABV_BUCKETS: ReadonlyArray<AbvBucket> = [
  { key: '0-5', label: '≤5%', min: null, max: 5 },
  { key: '5-7', label: '5–7%', min: 5, max: 7 },
  { key: '7-9', label: '7–9%', min: 7, max: 9 },
  { key: '9plus', label: '9%+', min: 9, max: null },
];

export function bucketForRange(abvMin: number | null, abvMax: number | null): string | null {
  const b = ABV_BUCKETS.find((x) => x.min === abvMin && x.max === abvMax);
  return b ? b.key : null;
}
```

with:

```typescript
export interface AbvPreset {
  key: string;
  label: string;
  min: number | null;
  max: number | null;
}

// Open-ended thresholds (not closed bands): a cap (`≤X`, max set) or a
// floor (`X+`, min set). Single-select. `≤5%` and `9%+` keep the (min,max)
// of the old bands so prior selections stay valid.
export const ABV_PRESETS: ReadonlyArray<AbvPreset> = [
  { key: 'lte3_5', label: '≤3.5%', min: null, max: 3.5 },
  { key: 'lte5', label: '≤5%', min: null, max: 5 },
  { key: 'gte5', label: '5%+', min: 5, max: null },
  { key: 'gte7', label: '7%+', min: 7, max: null },
  { key: 'gte9', label: '9%+', min: 9, max: null },
];

export function bucketForRange(abvMin: number | null, abvMax: number | null): string | null {
  const b = ABV_PRESETS.find((x) => x.min === abvMin && x.max === abvMax);
  return b ? b.key : null;
}
```

- [ ] **Step 4: Propagate the rename to `keyboards.ts`**

In `src/bot/keyboards.ts`, change the import:

```typescript
import { ABV_BUCKETS } from '../domain/filters';
```

to:

```typescript
import { ABV_PRESETS } from '../domain/filters';
```

And the abv row:

```typescript
  const abvRow = ABV_BUCKETS.map((b) =>
    Markup.button.callback(b.key === state.abvKey ? `✅ ${b.label}` : b.label, `abv:${b.key}`),
  );
```

to:

```typescript
  const abvRow = ABV_PRESETS.map((b) =>
    Markup.button.callback(b.key === state.abvKey ? `✅ ${b.label}` : b.label, `abv:${b.key}`),
  );
```

(Two-row split comes in Task 3; this is the mechanical rename only.)

- [ ] **Step 5: Propagate the rename to `commands/filters.ts`**

In `src/bot/commands/filters.ts`, change the import:

```typescript
import { topStyleFamilies, ABV_BUCKETS, bucketForRange } from '../../domain/filters';
```

to:

```typescript
import { topStyleFamilies, ABV_PRESETS, bucketForRange } from '../../domain/filters';
```

Change the summary line (still preset-label based for now; replaced in Task 2):

```typescript
  const abvStr = abvKey ? ABV_BUCKETS.find((b) => b.key === abvKey)!.label : t('filters.any');
```

to:

```typescript
  const abvStr = abvKey ? ABV_PRESETS.find((b) => b.key === abvKey)!.label : t('filters.any');
```

And the abv action lookup:

```typescript
          const b = ABV_BUCKETS.find((x) => x.key === key)!;
```

to:

```typescript
          const b = ABV_PRESETS.find((x) => x.key === key)!;
```

- [ ] **Step 6: Update the keyboard test ABV keys**

In `src/bot/keyboards.test.ts`, the ABV test sets `abvKey: '9plus'` and asserts old keys. Change the state object's `abvKey: '9plus'` to `abvKey: 'gte9'`, and replace:

```typescript
  expect(all.find((b) => b.callback_data === 'abv:9plus')!.text).toBe('✅ 9%+');
  expect(all.find((b) => b.callback_data === 'abv:0-5')!.text).toBe('≤5%');
```

with:

```typescript
  expect(all.find((b) => b.callback_data === 'abv:gte9')!.text).toBe('✅ 9%+');
  expect(all.find((b) => b.callback_data === 'abv:lte5')!.text).toBe('≤5%');
```

- [ ] **Step 7: Run tests + typecheck + grep guard**

Run: `npx jest src/domain/filters.test.ts src/bot/keyboards.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

Run: `grep -rn "ABV_BUCKETS\|AbvBucket" src/`
Expected: no output (rename complete).

- [ ] **Step 8: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts src/bot/keyboards.ts src/bot/keyboards.test.ts src/bot/commands/filters.ts
git commit -m "feat(filters): open-ended ABV threshold presets (rename ABV_BUCKETS→ABV_PRESETS)"
```

---

## Task 2: `formatAbvRange` + honest summary

**Files:**
- Modify: `src/domain/filters.ts` (add `formatAbvRange`)
- Modify: `src/domain/filters.test.ts` (tests)
- Modify: `src/bot/commands/filters.ts` (summary uses it)

- [ ] **Step 1: Write the failing test**

In `src/domain/filters.test.ts`, add `formatAbvRange` to the import:

```typescript
import { filterInteresting, rankByRating, topStyleFamilies, ABV_PRESETS, bucketForRange, formatAbvRange } from './filters';
```

Append:

```typescript
test('formatAbvRange renders caps, floors, bounded (stale), and null', () => {
  expect(formatAbvRange(null, 3.5)).toBe('≤3.5%');
  expect(formatAbvRange(null, 5)).toBe('≤5%');
  expect(formatAbvRange(5, null)).toBe('5%+');
  expect(formatAbvRange(9, null)).toBe('9%+');
  expect(formatAbvRange(5, 7)).toBe('5–7%');   // stale bounded range stays visible
  expect(formatAbvRange(null, null)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/filters.test.ts -t formatAbvRange`
Expected: FAIL — `formatAbvRange` is not exported.

- [ ] **Step 3: Implement `formatAbvRange`**

In `src/domain/filters.ts`, add after `bucketForRange`:

```typescript
// Honest display of the stored ABV range, independent of whether it matches a
// preset — so a stale bounded range (e.g. an old 5–7% band) is visible in the
// summary rather than silently filtering. null → caller shows "any".
export function formatAbvRange(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min == null) return `≤${max}%`;
  if (max == null) return `${min}%+`;
  return `${min}–${max}%`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/filters.test.ts -t formatAbvRange`
Expected: PASS.

- [ ] **Step 5: Wire the summary in the handler**

In `src/bot/commands/filters.ts`, add `formatAbvRange` to the import:

```typescript
import { topStyleFamilies, ABV_PRESETS, bucketForRange, formatAbvRange } from '../../domain/filters';
```

Replace the summary line:

```typescript
  const abvStr = abvKey ? ABV_PRESETS.find((b) => b.key === abvKey)!.label : t('filters.any');
```

with:

```typescript
  const abvStr = formatAbvRange(f.abv_min, f.abv_max) ?? t('filters.any');
```

(`abvKey = bucketForRange(...)` stays — it's still passed to `filtersKeyboard` for the ✓. `ABV_PRESETS` import stays — still used by the abv action.)

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npx jest src/domain/filters.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts src/bot/commands/filters.ts
git commit -m "feat(filters): honest ABV summary via formatAbvRange (shows stale ranges)"
```

---

## Task 3: two-row ABV layout

**Files:**
- Modify: `src/bot/keyboards.ts`
- Modify: `src/bot/keyboards.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/bot/keyboards.test.ts`, append a structural test (with no style families, the inline_keyboard rows are: ABV-caps, ABV-floors, rating, reset):

```typescript
test('filtersKeyboard splits ABV into a caps row and a floors row', () => {
  const kb = filtersKeyboard(t, { families: [], activeStyles: [], abvKey: null, minRating: null });
  const rows = kb.reply_markup.inline_keyboard as { callback_data: string }[][];
  expect(rows[0].map((b) => b.callback_data)).toEqual(['abv:lte3_5', 'abv:lte5']);
  expect(rows[1].map((b) => b.callback_data)).toEqual(['abv:gte5', 'abv:gte7', 'abv:gte9']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/bot/keyboards.test.ts -t "splits ABV"`
Expected: FAIL — currently a single ABV row (`rows[0]` is all 5 keys), so `rows[1]` is the rating row.

- [ ] **Step 3: Split the ABV row**

In `src/bot/keyboards.ts`, replace:

```typescript
  const abvRow = ABV_PRESETS.map((b) =>
    Markup.button.callback(b.key === state.abvKey ? `✅ ${b.label}` : b.label, `abv:${b.key}`),
  );
```

with:

```typescript
  const abvBtn = (b: (typeof ABV_PRESETS)[number]) =>
    Markup.button.callback(b.key === state.abvKey ? `✅ ${b.label}` : b.label, `abv:${b.key}`);
  const abvCapRow = ABV_PRESETS.filter((b) => b.max != null).map(abvBtn); // ≤X
  const abvFloorRow = ABV_PRESETS.filter((b) => b.min != null).map(abvBtn); // X+
```

Then in the `Markup.inlineKeyboard([...])` call, replace the line `abvRow,` with:

```typescript
    abvCapRow,
    abvFloorRow,
```

- [ ] **Step 4: Run the keyboard tests to verify they pass**

Run: `npx jest src/bot/keyboards.test.ts`
Expected: PASS — both the new split test and the existing `abv:gte9`/`abv:lte5` assertions (which flatten all rows).

- [ ] **Step 5: Commit**

```bash
git add src/bot/keyboards.ts src/bot/keyboards.test.ts
git commit -m "feat(filters): two-row ABV layout (caps row, floors row)"
```

---

## Task 4: update `spec.md`

**Files:**
- Modify: `spec.md`

No test. Keep the canonical spec in sync (CLAUDE.md rule).

- [ ] **Step 1: Update §3.9 ABV rows**

In `spec.md` §3.9, the `abv_min`/`abv_max` rows currently read `(керується ABV-бакетами в /filters)`. Replace both descriptions with:

```
| `abv_min` | REAL | nullable | мінімальний ABV (відкриті ABV-пороги в /filters) |
| `abv_max` | REAL | nullable | максимальний ABV (відкриті ABV-пороги в /filters) |
```

- [ ] **Step 2: Update the §4 `/filters` ABV bullet**

In `spec.md` §4, replace the ABV bullet:

```
- **ABV:** пресетні бакети `≤5%`/`5–7%`/`7–9%`/`9%+` (single-select); тап по
  активному очищає. Виставляють `user_filters.abv_min/abv_max`.
```

with:

```
- **ABV:** відкриті порогові пресети `≤3.5%`/`≤5%`/`5%+`/`7%+`/`9%+`
  (single-select, два ряди — кепи / флори); тап по активному очищає. Виставляють
  `user_filters.abv_min/abv_max`. Зведення показує реальний діапазон через
  `formatAbvRange` (вкл. stale-діапазони зі старих закритих смуг).
```

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): /filters ABV uses open-ended thresholds"
```

---

## Task 5: final verification

**Files:** none (verification only).

- [ ] **Step 1: Type check**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS — `tsc` emits with no errors.

- [ ] **Step 4: Confirm clean tree**

Run: `git status`
Expected: clean working tree (everything committed across Tasks 1–4).

---

## Self-Review

**Spec coverage** (design §2–§8):
- §2 five open-ended presets, `≤5%`/`9%+` preserve old `(min,max)` → Task 1 (`ABV_PRESETS` + tests).
- §2 two-row layout → Task 3 (caps/floors split + structural test).
- §3 honest stale handling via `formatAbvRange`, summary from raw values → Task 2.
- §4 rename `ABV_BUCKETS`→`ABV_PRESETS`, `bucketForRange` over 5, `filterInteresting` untouched → Task 1 (rename + grep guard); `filterInteresting` deliberately not modified (existing ABV test still green via the suite in Task 5).
- §5 edges: stale bounded range → Task 2 (`formatAbvRange(5,7)`→`5–7%` test); boundary 5.0 / null abv → covered by unchanged `filterInteresting`.
- §6 tests → Tasks 1–3 ship them; Task 5 runs the suite.
- §8 spec.md → Task 4.

**Placeholder scan:** none — every code step shows complete code; every run step shows command + expected result.

**Type consistency:** `AbvPreset` / `ABV_PRESETS` (keys `lte3_5`,`lte5`,`gte5`,`gte7`,`gte9`) used identically in Tasks 1 (filters + keyboards + command + tests), 2, 3. `bucketForRange(min,max): string|null` and `formatAbvRange(min,max): string|null` signatures match between definition (Tasks 1, 2) and use (command summary Task 2, keyboard ✓ via `abvKey`). The keyboard `FiltersKeyboardState.abvKey` field is unchanged; the two-row split (Task 3) reuses it. Callback keys (`abv:lte3_5` … `abv:gte9`) match between keyboard (Tasks 1, 3) and the `abv:(.+)` action handler (unchanged, keyed by `ABV_PRESETS`).
