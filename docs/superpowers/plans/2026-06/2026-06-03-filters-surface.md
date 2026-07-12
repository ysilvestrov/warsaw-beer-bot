# Filters Surface (ABV buckets + dynamic style families) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the `/filters` Telegram surface — wire the already-supported ABV range into single-select preset buckets, replace the 4 hardcoded styles with dynamic top-10 style families derived from Untappd style prefixes, and make the keyboard stateful (live re-render with ✓ on active filters).

**Architecture:** Pure logic lands in `src/domain/filters.ts` (`familyOf`, `topStyleFamilies`, `ABV_BUCKETS`, `bucketForRange`, plus a family-equality switch in `filterInteresting`). A new `currentTapStyles` query lives in `src/storage/snapshots.ts`. `src/bot/keyboards.ts` gets a pure data-driven `filtersKeyboard(t, state)`. `src/bot/commands/filters.ts` becomes a thin handler that builds state, renders, and re-renders on every tap. i18n keys are restructured.

**Tech Stack:** Node.js ≥20, TypeScript (strict), Telegraf, better-sqlite3, Jest. Tests run with `npx jest`, types with `npm run typecheck`.

**Design reference:** `docs/superpowers/specs/2026-06-03-filters-surface-design.md`

---

## File Structure

- **Modify** `src/domain/filters.ts` — add `familyOf`, `topStyleFamilies`, `ABV_BUCKETS`, `bucketForRange`; switch `filterInteresting` style match to family-equality.
- **Modify** `src/domain/filters.test.ts` — tests for all new pure functions + family-equality behavior.
- **Modify** `src/storage/snapshots.ts` — add `currentTapStyles(db)`.
- **Modify** `src/storage/snapshots.test.ts` — test for `currentTapStyles`.
- **Modify** `src/i18n/types.ts` — restructure `filters.*` keys in `Messages`.
- **Modify** `src/i18n/locales/{uk,pl,en}.ts` — restructured filter strings.
- **Modify** `src/bot/keyboards.ts` — rewrite `filtersKeyboard` to take state; import `ABV_BUCKETS`.
- **Create** `src/bot/keyboards.test.ts` — render test for `filtersKeyboard`.
- **Modify** `src/bot/commands/filters.ts` — stateful render + re-render handlers.
- **Modify** `spec.md` — update §3.9, §4 (`/filters`), §5.7.

---

## Task 1: `familyOf` — derive style family from Untappd prefix

**Files:**
- Modify: `src/domain/filters.ts`
- Test: `src/domain/filters.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/filters.test.ts`:

```typescript
import { filterInteresting, rankByRating, familyOf } from './filters';

test('familyOf splits on the first " - " and trims', () => {
  expect(familyOf('IPA - American')).toBe('IPA');
  expect(familyOf('Sour - Fruited - Other')).toBe('Sour');
  expect(familyOf('Mead')).toBe('Mead');
  expect(familyOf('  Pilsner - German  ')).toBe('Pilsner');
  expect(familyOf(null)).toBeNull();
  expect(familyOf('')).toBeNull();
  expect(familyOf('   ')).toBeNull();
});
```

(Replace the existing `import { filterInteresting, rankByRating } from './filters';` line at the top of the file with the new import line above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/filters.test.ts -t familyOf`
Expected: FAIL — `familyOf is not a function` / TS2305 export missing.

- [ ] **Step 3: Write minimal implementation**

Add to `src/domain/filters.ts` (top of file, before `filterInteresting`):

```typescript
export function familyOf(style: string | null): string | null {
  if (style == null) return null;
  const trimmed = style.trim();
  if (trimmed === '') return null;
  const idx = trimmed.indexOf(' - ');
  const fam = (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim();
  return fam === '' ? null : fam;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/filters.test.ts -t familyOf`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "feat(filters): familyOf — derive style family from Untappd prefix"
```

---

## Task 2: `topStyleFamilies` — top-10 present ∪ active

**Files:**
- Modify: `src/domain/filters.ts`
- Test: `src/domain/filters.test.ts`

- [ ] **Step 1: Write the failing test**

Add the symbol to the import line at the top of `src/domain/filters.test.ts` so it reads:

```typescript
import { filterInteresting, rankByRating, familyOf, topStyleFamilies } from './filters';
```

Append:

```typescript
test('topStyleFamilies ranks present families by count, then alpha, caps at n', () => {
  const styles = [
    'IPA - American', 'IPA - Imperial', 'IPA - New England',  // IPA x3
    'Sour - Fruited', 'Sour - Other',                          // Sour x2
    'Lager - Pale',                                            // Lager x1
    'Stout - Imperial',                                        // Stout x1
    null, '',                                                  // ignored
  ];
  expect(topStyleFamilies(styles, [], 2)).toEqual(['IPA', 'Sour']);
  // count tie (Lager 1, Stout 1) breaks alphabetically
  expect(topStyleFamilies(styles, [], 4)).toEqual(['IPA', 'Sour', 'Lager', 'Stout']);
});

test('topStyleFamilies appends active families absent from the top-n (alpha)', () => {
  const styles = ['IPA - American', 'IPA - Imperial'];
  // Saison + Bock are active but not on tap → appended, alpha-sorted, after present
  expect(topStyleFamilies(styles, ['Saison', 'IPA', 'Bock'], 1)).toEqual(['IPA', 'Bock', 'Saison']);
});

test('topStyleFamilies on empty taps returns only active families', () => {
  expect(topStyleFamilies([], ['Stout'], 10)).toEqual(['Stout']);
  expect(topStyleFamilies([], [], 10)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/filters.test.ts -t topStyleFamilies`
Expected: FAIL — `topStyleFamilies is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/domain/filters.ts` (after `familyOf`):

```typescript
export function topStyleFamilies(
  currentTapStyles: (string | null)[],
  activeStyles: string[],
  n = 10,
): string[] {
  const counts = new Map<string, number>();
  for (const s of currentTapStyles) {
    const fam = familyOf(s);
    if (fam == null) continue;
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([fam]) => fam);

  const present = new Set(top.map((f) => f.toLowerCase()));
  const extraActive = activeStyles
    .filter((f) => !present.has(f.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  return [...top, ...extraActive];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/filters.test.ts -t topStyleFamilies`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "feat(filters): topStyleFamilies — top-N present families unioned with active"
```

---

## Task 3: `ABV_BUCKETS` + `bucketForRange`

**Files:**
- Modify: `src/domain/filters.ts`
- Test: `src/domain/filters.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the top import to:

```typescript
import { filterInteresting, rankByRating, familyOf, topStyleFamilies, ABV_BUCKETS, bucketForRange } from './filters';
```

Append:

```typescript
test('ABV_BUCKETS are the four agreed single-select ranges', () => {
  expect(ABV_BUCKETS.map((b) => b.key)).toEqual(['0-5', '5-7', '7-9', '9plus']);
  expect(ABV_BUCKETS.map((b) => [b.min, b.max])).toEqual([
    [null, 5], [5, 7], [7, 9], [9, null],
  ]);
});

test('bucketForRange maps an exact (min,max) pair to its key, else null', () => {
  expect(bucketForRange(null, 5)).toBe('0-5');
  expect(bucketForRange(5, 7)).toBe('5-7');
  expect(bucketForRange(9, null)).toBe('9plus');
  expect(bucketForRange(null, null)).toBeNull();
  expect(bucketForRange(4, 6)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/filters.test.ts -t ABV` and `npx jest src/domain/filters.test.ts -t bucketForRange`
Expected: FAIL — `ABV_BUCKETS` / `bucketForRange` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/domain/filters.ts` (after `topStyleFamilies`):

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/filters.test.ts -t ABV` then `npx jest src/domain/filters.test.ts -t bucketForRange`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "feat(filters): ABV_BUCKETS + bucketForRange (single-select ranges)"
```

---

## Task 4: switch `filterInteresting` style match to family-equality

**Files:**
- Modify: `src/domain/filters.ts:24-27` (the `styles` branch of `filterInteresting`)
- Test: `src/domain/filters.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/filters.test.ts`:

```typescript
test('filterInteresting matches styles by family, not substring', () => {
  const rows = [
    { beer_id: 10, style: 'IPA - American',    abv: 6, u_rating: 4 },
    { beer_id: 11, style: 'Pale Ale - American', abv: 5, u_rating: 4 },
    { beer_id: 12, style: 'Stout - Imperial',  abv: 9, u_rating: 4 },
    { beer_id: 13, style: null,                abv: 5, u_rating: 4 },
  ];
  // selecting 'IPA' must NOT pull in 'Pale Ale' (old substring 'IPA'.includes — n/a;
  // but selecting 'Ale' previously matched 'Pale Ale' — now family-equality forbids it)
  expect(filterInteresting(rows, new Set(), { styles: ['IPA'] }).map((r) => r.beer_id)).toEqual([10]);
  expect(filterInteresting(rows, new Set(), { styles: ['Ale'] }).map((r) => r.beer_id)).toEqual([]);
  // case-insensitive family match
  expect(filterInteresting(rows, new Set(), { styles: ['stout'] }).map((r) => r.beer_id)).toEqual([12]);
  // null style never matches a selected family
  expect(filterInteresting(rows, new Set(), { styles: ['IPA', 'Stout'] }).map((r) => r.beer_id)).toEqual([10, 12]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/filters.test.ts -t "by family"`
Expected: FAIL — `['Ale']` currently matches `Pale Ale` via substring (returns `[11]`, not `[]`).

- [ ] **Step 3: Write minimal implementation**

In `src/domain/filters.ts`, replace the `styles` branch inside `filterInteresting`:

```typescript
    if (opts.styles && opts.styles.length) {
      const s = (t.style ?? '').toLowerCase();
      if (!opts.styles.some((x) => s.includes(x.toLowerCase()))) return false;
    }
```

with:

```typescript
    if (opts.styles && opts.styles.length) {
      const fam = familyOf(t.style);
      if (fam == null || !opts.styles.some((x) => x.toLowerCase() === fam.toLowerCase())) {
        return false;
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass (incl. the existing regression test)**

Run: `npx jest src/domain/filters.test.ts`
Expected: PASS — all tests, including the pre-existing `filterInteresting respects checkins + style + rating + abv` (style `'IPA'` still family-matches `['IPA']`).

- [ ] **Step 5: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "feat(filters): match styles by family-equality, not substring"
```

---

## Task 5: `currentTapStyles` storage query

**Files:**
- Modify: `src/storage/snapshots.ts`
- Test: `src/storage/snapshots.test.ts`

- [ ] **Step 1: Write the failing test**

Add `currentTapStyles` to the import in `src/storage/snapshots.test.ts` so the import line reads:

```typescript
import { createSnapshot, latestSnapshot, insertTaps, tapsForSnapshot, tapsForSnapshotWithBeer, currentTapStyles } from './snapshots';
```

Append:

```typescript
test('currentTapStyles returns styles from the latest snapshot of each pub only', () => {
  const { db, pubId } = setup();
  const pubId2 = upsertPub(db, { slug: 'q', name: 'Q', address: null, lat: null, lon: null });

  // older snapshot for pub 1 — must be ignored
  const old = createSnapshot(db, pubId, '2026-06-01T10:00:00Z');
  insertTaps(db, old, [
    { tap_number: 1, beer_ref: 'old', brewery_ref: null, abv: 5, ibu: null, style: 'Porter - Baltic', u_rating: null },
  ]);
  // latest snapshot for pub 1
  const cur1 = createSnapshot(db, pubId, '2026-06-03T10:00:00Z');
  insertTaps(db, cur1, [
    { tap_number: 1, beer_ref: 'a', brewery_ref: null, abv: 6, ibu: null, style: 'IPA - American', u_rating: null },
    { tap_number: 2, beer_ref: 'b', brewery_ref: null, abv: 5, ibu: null, style: null, u_rating: null },
  ]);
  // latest snapshot for pub 2
  const cur2 = createSnapshot(db, pubId2, '2026-06-03T11:00:00Z');
  insertTaps(db, cur2, [
    { tap_number: 1, beer_ref: 'c', brewery_ref: null, abv: 7, ibu: null, style: 'Sour - Fruited', u_rating: null },
  ]);

  const styles = currentTapStyles(db).sort();
  expect(styles).toEqual(['IPA - American', 'Sour - Fruited']); // no Porter (old), no null
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/snapshots.test.ts -t currentTapStyles`
Expected: FAIL — `currentTapStyles is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/storage/snapshots.ts` (end of file):

```typescript
export function currentTapStyles(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT t.style AS style
         FROM taps t
         JOIN tap_snapshots s ON s.id = t.snapshot_id
         JOIN (
           SELECT pub_id, MAX(snapshot_at) AS m FROM tap_snapshots GROUP BY pub_id
         ) x ON x.pub_id = s.pub_id AND x.m = s.snapshot_at
        WHERE t.style IS NOT NULL`,
    )
    .all() as { style: string }[];
  return rows.map((r) => r.style);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/snapshots.test.ts -t currentTapStyles`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/snapshots.ts src/storage/snapshots.test.ts
git commit -m "feat(snapshots): currentTapStyles — styles from latest snapshot per pub"
```

---

## Task 6: i18n — restructure `filters.*` keys

**Files:**
- Modify: `src/i18n/types.ts` (the `// filters` block of `Messages`)
- Modify: `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`, `src/i18n/locales/en.ts`

This task has no Jest test; the `Messages` interface is the contract and `npm run typecheck` enforces that every locale provides exactly the declared keys.

- [ ] **Step 1: Update the `Messages` interface**

In `src/i18n/types.ts`, replace the `// filters` block:

```typescript
  // filters
  'filters.current': string;             // {styles}, {min_rating}
  'filters.styles_changed': string;      // {styles}
  'filters.rating_changed': string;      // {rating}
  'filters.reset_done': string;          // callback answer after reset
  'filters.reset_button': string;        // inline-keyboard button label
```

with:

```typescript
  // filters
  'filters.current': string;             // {styles}, {abv}, {rating} — multi-line summary
  'filters.any': string;                 // value shown when a filter is unset
  'filters.rating_value': string;        // {rating} — e.g. "from 3.8"
  'filters.reset_done': string;          // callback answer after reset
  'filters.reset_button': string;        // inline-keyboard button label
```

- [ ] **Step 2: Update `uk.ts`**

In `src/i18n/locales/uk.ts`, replace the `// filters` block:

```typescript
  // filters
  'filters.current': 'Поточні: styles={styles}, min_rating={min_rating}',
  'filters.styles_changed': 'styles={styles}',
  'filters.rating_changed': 'min_rating={rating}',
  'filters.reset_done': 'Скинуто',
  'filters.reset_button': 'Скинути',
```

with:

```typescript
  // filters
  'filters.current':
    '🎛 Твої фільтри\nСтилі: {styles}\nМіцність: {abv}\nРейтинг: {rating}\n\nТисни, щоб увімкнути/вимкнути. ♻️ — скинути все.',
  'filters.any': 'будь-яка',
  'filters.rating_value': 'від {rating}',
  'filters.reset_done': 'Скинуто',
  'filters.reset_button': '♻️ Скинути все',
```

- [ ] **Step 3: Update `pl.ts`**

In `src/i18n/locales/pl.ts`, replace the `// filters` block:

```typescript
  // filters
  'filters.current': 'Aktualne: styles={styles}, min_rating={min_rating}',
  'filters.styles_changed': 'styles={styles}',
  'filters.rating_changed': 'min_rating={rating}',
  'filters.reset_done': 'Zresetowano',
  'filters.reset_button': 'Resetuj',
```

with:

```typescript
  // filters
  'filters.current':
    '🎛 Twoje filtry\nStyle: {styles}\nMoc: {abv}\nOcena: {rating}\n\nKliknij, aby włączyć/wyłączyć. ♻️ — zresetuj wszystko.',
  'filters.any': 'dowolna',
  'filters.rating_value': 'od {rating}',
  'filters.reset_done': 'Zresetowano',
  'filters.reset_button': '♻️ Zresetuj wszystko',
```

- [ ] **Step 4: Update `en.ts`**

In `src/i18n/locales/en.ts`, replace the `// filters` block:

```typescript
  // filters
  'filters.current': 'Current: styles={styles}, min_rating={min_rating}',
  'filters.styles_changed': 'styles={styles}',
  'filters.rating_changed': 'min_rating={rating}',
  'filters.reset_done': 'Filters reset',
  'filters.reset_button': 'Reset',
```

with:

```typescript
  // filters
  'filters.current':
    '🎛 Your filters\nStyles: {styles}\nABV: {abv}\nRating: {rating}\n\nTap to toggle. ♻️ — reset all.',
  'filters.any': 'any',
  'filters.rating_value': 'from {rating}',
  'filters.reset_done': 'Filters reset',
  'filters.reset_button': '♻️ Reset all',
```

- [ ] **Step 5: Verify types (expected to FAIL here)**

Run: `npm run typecheck`
Expected: FAIL — `src/bot/commands/filters.ts` still references the removed `filters.styles_changed` / `filters.rating_changed` keys. This is expected; Task 8 fixes the handler. Do not commit yet.

- [ ] **Step 6: Commit (deferred with Task 8)**

i18n changes are committed together with the handler in Task 8 Step 5, because they are mutually dependent (the build is red in between). Proceed to Task 7.

---

## Task 7: pure `filtersKeyboard(t, state)` + render test

**Files:**
- Modify: `src/bot/keyboards.ts`
- Create: `src/bot/keyboards.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bot/keyboards.test.ts`:

```typescript
import { filtersKeyboard } from './keyboards';
import type { Translator } from '../i18n/types';

const t: Translator = (key) => (key === 'filters.reset_button' ? '♻️ Reset all' : String(key));

function buttons(markup: ReturnType<typeof filtersKeyboard>) {
  return markup.reply_markup.inline_keyboard.flat();
}

test('filtersKeyboard marks active style with ✓ and keeps callback data clean', () => {
  const kb = filtersKeyboard(t, {
    families: ['IPA', 'Sour', 'Pale Ale'],
    activeStyles: ['IPA'],
    abvKey: null,
    minRating: null,
  });
  const all = buttons(kb);
  const ipa = all.find((b) => b.callback_data === 'style:IPA')!;
  const sour = all.find((b) => b.callback_data === 'style:Sour')!;
  const pale = all.find((b) => b.callback_data === 'style:Pale Ale')!;
  expect(ipa.text).toBe('✅ IPA');
  expect(sour.text).toBe('Sour');
  expect(pale.text).toBe('Pale Ale'); // family with a space round-trips in callback_data
});

test('filtersKeyboard renders ABV buckets, rating presets and reset; marks active', () => {
  const kb = filtersKeyboard(t, {
    families: [],
    activeStyles: [],
    abvKey: '9plus',
    minRating: 3.8,
  });
  const all = buttons(kb);
  expect(all.find((b) => b.callback_data === 'abv:9plus')!.text).toBe('✅ 9%+');
  expect(all.find((b) => b.callback_data === 'abv:0-5')!.text).toBe('≤5%');
  expect(all.find((b) => b.callback_data === 'rating:3.8')!.text).toBe('✅ min 3.8');
  expect(all.find((b) => b.callback_data === 'rating:3.5')!.text).toBe('min 3.5');
  expect(all.find((b) => b.callback_data === 'reset')!.text).toBe('♻️ Reset all');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/bot/keyboards.test.ts`
Expected: FAIL — current `filtersKeyboard` takes only `t` and renders hardcoded styles; new signature/state not present.

- [ ] **Step 3: Write the implementation**

Replace the `filtersKeyboard` definition in `src/bot/keyboards.ts` (keep `langKeyboard` untouched) and add imports/state type:

```typescript
import { Markup } from 'telegraf';
import type { Translator } from '../i18n/types';
import { ABV_BUCKETS } from '../domain/filters';

export const langKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇦 Українська', 'lang:uk')],
    [Markup.button.callback('🇵🇱 Polski', 'lang:pl')],
    [Markup.button.callback('🇬🇧 English', 'lang:en')],
  ]);

export interface FiltersKeyboardState {
  families: string[];        // already ordered: top-N present ∪ active
  activeStyles: string[];
  abvKey: string | null;     // active ABV bucket key, or null
  minRating: number | null;  // active rating preset, or null
}

const RATING_PRESETS = [3.5, 3.8] as const;

export const filtersKeyboard = (t: Translator, state: FiltersKeyboardState) => {
  const activeLc = new Set(state.activeStyles.map((s) => s.toLowerCase()));

  const styleRows = [];
  for (let i = 0; i < state.families.length; i += 2) {
    const row = state.families.slice(i, i + 2).map((fam) => {
      const on = activeLc.has(fam.toLowerCase());
      return Markup.button.callback(on ? `✅ ${fam}` : fam, `style:${fam}`);
    });
    styleRows.push(row);
  }

  const abvRow = ABV_BUCKETS.map((b) =>
    Markup.button.callback(b.key === state.abvKey ? `✅ ${b.label}` : b.label, `abv:${b.key}`),
  );

  const ratingRow = RATING_PRESETS.map((r) =>
    Markup.button.callback(state.minRating === r ? `✅ min ${r}` : `min ${r}`, `rating:${r}`),
  );

  return Markup.inlineKeyboard([
    ...styleRows,
    abvRow,
    ratingRow,
    [Markup.button.callback(t('filters.reset_button'), 'reset')],
  ]);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/bot/keyboards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/keyboards.ts src/bot/keyboards.test.ts
git commit -m "feat(keyboards): stateful filtersKeyboard with ✓ on active filters + ABV buckets"
```

---

## Task 8: stateful `/filters` handler (build + live re-render)

**Files:**
- Modify: `src/bot/commands/filters.ts` (full rewrite)

No Jest test (thin Telegraf glue; all logic is covered by the pure functions in Tasks 1–7). Verification is `npm run typecheck` + `npm test` green.

- [ ] **Step 1: Rewrite the handler**

Replace the entire contents of `src/bot/commands/filters.ts` with:

```typescript
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { filtersKeyboard } from '../keyboards';
import { getFilters, setFilters, type Filters } from '../../storage/user_filters';
import { ensureProfile } from '../../storage/user_profiles';
import { currentTapStyles } from '../../storage/snapshots';
import { topStyleFamilies, ABV_BUCKETS, bucketForRange } from '../../domain/filters';
import type { DB } from '../../storage/db';
import type { Translator } from '../../i18n/types';

const emptyFilters = (): Filters => ({
  styles: [],
  min_rating: null,
  abv_min: null,
  abv_max: null,
  default_route_n: null,
});

function render(t: Translator, db: DB, f: Filters): { text: string; kb: ReturnType<typeof filtersKeyboard> } {
  const families = topStyleFamilies(currentTapStyles(db), f.styles, 10);
  const abvKey = bucketForRange(f.abv_min, f.abv_max);
  const stylesStr = f.styles.length ? f.styles.join(', ') : t('filters.any');
  const abvStr = abvKey ? ABV_BUCKETS.find((b) => b.key === abvKey)!.label : t('filters.any');
  const ratingStr = f.min_rating != null ? t('filters.rating_value', { rating: f.min_rating }) : t('filters.any');
  const text = t('filters.current', { styles: stylesStr, abv: abvStr, rating: ratingStr });
  const kb = filtersKeyboard(t, { families, activeStyles: f.styles, abvKey, minRating: f.min_rating });
  return { text, kb };
}

// Telegram rejects an editMessageText that produces identical content with
// "message is not modified" — harmless here (e.g. reset while already empty).
async function safeEdit(ctx: BotContext, text: string, kb: ReturnType<typeof filtersKeyboard>): Promise<void> {
  try {
    await ctx.editMessageText(text, kb);
  } catch (e) {
    const msg = String((e as { description?: string; message?: string })?.description ?? (e as Error)?.message ?? '');
    if (!msg.includes('message is not modified')) throw e;
  }
}

export const filtersCommand = new Composer<BotContext>();

filtersCommand.command('filters', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const f = getFilters(ctx.deps.db, ctx.from.id) ?? emptyFilters();
  const { text, kb } = render(ctx.t, ctx.deps.db, f);
  await ctx.reply(text, kb);
});

filtersCommand.action(/style:(.+)/, async (ctx) => {
  const style = ctx.match[1];
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? emptyFilters();
  const styles = f.styles.includes(style)
    ? f.styles.filter((s) => s !== style)
    : [...f.styles, style];
  const next = { ...f, styles };
  setFilters(ctx.deps.db, ctx.from!.id, next);
  const { text, kb } = render(ctx.t, ctx.deps.db, next);
  await safeEdit(ctx, text, kb);
  await ctx.answerCbQuery();
});

filtersCommand.action(/abv:(.+)/, async (ctx) => {
  const key = ctx.match[1];
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? emptyFilters();
  const cur = bucketForRange(f.abv_min, f.abv_max);
  const next =
    cur === key
      ? { ...f, abv_min: null, abv_max: null }
      : (() => {
          const b = ABV_BUCKETS.find((x) => x.key === key)!;
          return { ...f, abv_min: b.min, abv_max: b.max };
        })();
  setFilters(ctx.deps.db, ctx.from!.id, next);
  const { text, kb } = render(ctx.t, ctx.deps.db, next);
  await safeEdit(ctx, text, kb);
  await ctx.answerCbQuery();
});

filtersCommand.action(/rating:(.+)/, async (ctx) => {
  const r = parseFloat(ctx.match[1]);
  const f = getFilters(ctx.deps.db, ctx.from!.id) ?? emptyFilters();
  const next = { ...f, min_rating: f.min_rating === r ? null : r };
  setFilters(ctx.deps.db, ctx.from!.id, next);
  const { text, kb } = render(ctx.t, ctx.deps.db, next);
  await safeEdit(ctx, text, kb);
  await ctx.answerCbQuery();
});

filtersCommand.action('reset', async (ctx) => {
  const next = emptyFilters();
  setFilters(ctx.deps.db, ctx.from!.id, next);
  const { text, kb } = render(ctx.t, ctx.deps.db, next);
  await safeEdit(ctx, text, kb);
  await ctx.answerCbQuery(ctx.t('filters.reset_done'));
});
```

- [ ] **Step 2: Verify types**

Run: `npm run typecheck`
Expected: PASS — the removed `filters.styles_changed` / `filters.rating_changed` references are gone; `Filters` is imported as a type from `user_filters`.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 4: Commit (includes Task 6 i18n changes)**

```bash
git add src/bot/commands/filters.ts src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts
git commit -m "feat(filters): stateful /filters — dynamic families, ABV buckets, live re-render"
```

---

## Task 9: update `spec.md`

**Files:**
- Modify: `spec.md`

No test. Keep the canonical spec in sync (project rule from CLAUDE.md: update `spec.md` in the same PR when behavior changes).

- [ ] **Step 1: Update §3.9 (`user_filters`) ABV note**

In `spec.md` §3.9, change the two ABV rows' descriptions from `(у схемі; ще не в кнопках)` to `(керується ABV-бакетами в /filters)`:

```
| `abv_min` | REAL | nullable | мінімальний ABV (керується ABV-бакетами в /filters) |
| `abv_max` | REAL | nullable | максимальний ABV (керується ABV-бакетами в /filters) |
```

- [ ] **Step 2: Update §4 `/filters` description**

Replace the `/filters` bullet in §4 with:

```
### `/filters` — інлайн-фільтри
Стейтфул інлайн-клавіатура; кожен тап перемальовує клавіатуру й
повідомлення-зведення (✓ на активних фільтрах).
- **Стилі:** топ-10 родин (`familyOf` = частина Untappd-стилю до `" - "`),
  що є на кранах прямо зараз, ∪ активні родини користувача (multi-select).
  Матчинг — family-equality (`domain/filters.ts`), не substring.
- **ABV:** пресетні бакети `≤5%`/`5–7%`/`7–9%`/`9%+` (single-select); тап по
  активному очищає. Виставляють `user_filters.abv_min/abv_max`.
- **Рейтинг:** пресети `min 3.5`/`min 3.8` (тап по активному очищає).
- **♻️ Скинути все** — очищає всі фільтри.
Поточний стан показано в тілі повідомлення.
```

- [ ] **Step 3: Update §5.7 note**

In `spec.md`, remove any remaining wording that ABV filters exist "в схемі, але не в кнопках" (search for `abv` / `кнопк`). If §4's old "ABV-фільтри є в схемі, але не в кнопках — додати при потребі" line still exists anywhere, delete it.

- [ ] **Step 4: Commit**

```bash
git add spec.md
git commit -m "docs(spec): /filters now has ABV buckets + dynamic style families"
```

---

## Task 10: final verification

**Files:** none (verification only).

- [ ] **Step 1: Full type check**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — all suites green, including the new `familyOf`, `topStyleFamilies`, `ABV_BUCKETS`/`bucketForRange`, family-equality, `currentTapStyles`, and `filtersKeyboard` tests.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS — `tsc` emits to `dist/` with no errors.

- [ ] **Step 4: Confirm clean tree**

Run: `git status`
Expected: clean working tree (everything committed across Tasks 1–9).

---

## Self-Review

**Spec coverage** (design §2–§8):
- §2.1 dynamic families → Tasks 1, 2 (`familyOf`, `topStyleFamilies`) + Task 5 (`currentTapStyles`) + Task 7/8 (render & wire).
- §2.2 ABV buckets single-select → Task 3 + Task 8 (abv action with clear-on-retap).
- §2.3 stateful keyboard → Task 7 (✓ render) + Task 8 (live re-render via `safeEdit`).
- §2.4 family-equality matching → Task 4.
- §3.5 i18n restructure → Task 6.
- §5 edge cases: empty snapshot → Task 2 test ("only active") + Task 5; stranded active family → Task 2 test ("appends active absent"); dashless style → Task 1 test (`Mead`); null style → Task 4 test. Legacy `"Pils"` → no migration (design §5/§7), no task needed.
- §6 testing → Tasks 1–7 each ship their tests; Task 10 runs the suite.
- §8 spec.md updates → Task 9.

**Placeholder scan:** none — every code step shows complete code; every run step shows the command + expected result.

**Type consistency:** `familyOf(style: string | null): string | null`, `topStyleFamilies(styles, active, n)`, `ABV_BUCKETS` items `{key,label,min,max}`, `bucketForRange(min,max): string|null`, `FiltersKeyboardState {families, activeStyles, abvKey, minRating}`, `Filters` (imported from `user_filters`), and the i18n keys (`filters.current` {styles,abv,rating}, `filters.any`, `filters.rating_value`, `filters.reset_done`, `filters.reset_button`) are used consistently across Tasks 1–9. Callback names (`style:`, `abv:`, `rating:`, `reset`) match between keyboard (Task 7) and handler (Task 8).
