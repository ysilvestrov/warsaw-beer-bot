# Style Family Canonicalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `familyOf` (prefix-before-`" - "`) style grouping with `canonicalStyleFamily` — an ordered keyword-rule engine that maps ontap.pl's free-text multilingual style strings to ~11 canonical families plus an `Other` bucket.

**Architecture:** A new pure module `src/domain/style-family.ts` owns the family rule table and `canonicalStyleFamily(style)`. It reuses `baseNormalize` (newly exported from `normalize.ts`). `canonicalStyleFamily` replaces `familyOf` at both call sites in `domain/filters.ts` (`topStyleFamilies`, `filterInteresting`); `familyOf` is deleted. The `Other` family is the one whose stored identifier (`'Other'`) differs from its localized display label.

**Tech Stack:** Node.js ≥20, TypeScript (strict), Telegraf, Jest. Tests: `npx jest`, types: `npm run typecheck`.

**Design reference:** `docs/superpowers/specs/2026-06-03-style-family-canonicalization-design.md`

---

## File Structure

- **Modify** `src/domain/normalize.ts` — export the existing private `baseNormalize`.
- **Create** `src/domain/style-family.ts` — `OTHER_FAMILY`, `FAMILY_RULES`, `canonicalStyleFamily`.
- **Create** `src/domain/style-family.test.ts` — unit tests over real style clusters.
- **Modify** `src/domain/filters.ts` — delete `familyOf`; `topStyleFamilies` + `filterInteresting` use `canonicalStyleFamily`.
- **Modify** `src/domain/filters.test.ts` — drop the `familyOf` import + test; keep the (still-valid) family-equality + topStyleFamilies tests.
- **Modify** `src/i18n/types.ts` — add `filters.family_other`.
- **Modify** `src/i18n/locales/{uk,pl,en}.ts` — add `filters.family_other`.
- **Modify** `src/bot/keyboards.ts` — render `OTHER_FAMILY` with a localized label.
- **Modify** `src/bot/commands/filters.ts` — localize `Other` in the summary line.
- **Create** add render case in `src/bot/keyboards.test.ts` — `Other` label.
- **Modify** `spec.md` — §4 `/filters`.

---

## Task 1: `canonicalStyleFamily` engine

**Files:**
- Modify: `src/domain/normalize.ts:21` (export `baseNormalize`)
- Create: `src/domain/style-family.ts`
- Create: `src/domain/style-family.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/style-family.test.ts`:

```typescript
import { canonicalStyleFamily, OTHER_FAMILY } from './style-family';

test('IPA family — variants, compounds, casing', () => {
  for (const s of ['American IPA', 'West Coast IPA', 'Hazy IPA', 'AIPA', 'NEIPA', 'WEST COAST IPA', 'Session IPA', 'Cold IPA']) {
    expect(canonicalStyleFamily(s)).toBe('IPA');
  }
  expect(canonicalStyleFamily('Wheat IPA')).toBe('IPA'); // IPA wins over Wheat
});

test('Wheat family — multilingual', () => {
  for (const s of ['Weizen', 'Pszeniczne', 'Hefeweizen', 'HEFEWEIZEN', 'Witbier', 'Belgian Witbier', 'German Hefeweizen']) {
    expect(canonicalStyleFamily(s)).toBe('Wheat');
  }
});

test('Lager family — diacritics, Polish/Czech, Pils, Desitka', () => {
  for (const s of ['Lager', 'Pils', 'Czeski Lager', 'Svetlý Ležák', 'Svetly Lezak', 'Pale Lager', 'Vienna Lager', 'Desitka']) {
    expect(canonicalStyleFamily(s)).toBe('Lager');
  }
});

test('Lambic strips qualifier', () => {
  expect(canonicalStyleFamily('Lambic wiśniowy')).toBe('Lambic');
});

test('Sour absorbs Gose and Pastry Sour', () => {
  expect(canonicalStyleFamily('Pastry Sour')).toBe('Sour');
  expect(canonicalStyleFamily('Gose')).toBe('Sour');
});

test('Pastry Stout/Porter resolve to base family, not Sour (priority)', () => {
  expect(canonicalStyleFamily('Pastry Stout')).toBe('Stout');
  expect(canonicalStyleFamily('Pastry Porter')).toBe('Porter');
  expect(canonicalStyleFamily('Milk Stout')).toBe('Stout');
  expect(canonicalStyleFamily('India Export Porter')).toBe('Porter');
});

test('Pale Ale needs apa OR pale+ale; Pale Lager is not Pale Ale', () => {
  expect(canonicalStyleFamily('American Pale Ale')).toBe('Pale Ale');
  expect(canonicalStyleFamily('New Zealand APA')).toBe('Pale Ale');
  expect(canonicalStyleFamily('Pale Lager')).toBe('Lager');
});

test('unmatched / empty / null fall into Other', () => {
  expect(canonicalStyleFamily('PROSECCO')).toBe(OTHER_FAMILY);
  expect(canonicalStyleFamily('')).toBe(OTHER_FAMILY);
  expect(canonicalStyleFamily(null)).toBe(OTHER_FAMILY);
  expect(OTHER_FAMILY).toBe('Other');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/style-family.test.ts`
Expected: FAIL — `Cannot find module './style-family'`.

- [ ] **Step 3: Export `baseNormalize` from `normalize.ts`**

In `src/domain/normalize.ts`, change the declaration:

```typescript
function baseNormalize(s: string): string {
```

to:

```typescript
export function baseNormalize(s: string): string {
```

- [ ] **Step 4: Create the engine**

Create `src/domain/style-family.ts`:

```typescript
import { baseNormalize } from './normalize';

export const OTHER_FAMILY = 'Other';

interface FamilyRule {
  family: string;
  keywords: string[];
}

// Ordered: first matching rule wins, so order encodes priority.
// "Loud" families (IPA, Stout, Porter) precede Sour so that "Pastry Stout" /
// "Pastry Porter" resolve to their base family rather than Sour's `pastry`
// keyword. Pale Ale is special-cased (see canonicalStyleFamily) to avoid
// swallowing "Pale Lager".
export const FAMILY_RULES: ReadonlyArray<FamilyRule> = [
  { family: 'IPA', keywords: ['ipa', 'aipa', 'neipa', 'dipa', 'tipa', 'wcipa', 'neneipa'] },
  { family: 'Stout', keywords: ['stout'] },
  { family: 'Porter', keywords: ['porter'] },
  { family: 'Sour', keywords: ['sour', 'gose', 'kwasne', 'kwasny', 'pastry'] },
  { family: 'Lambic', keywords: ['lambic', 'gueuze'] },
  { family: 'Saison', keywords: ['saison'] },
  { family: 'Pale Ale', keywords: ['apa'] }, // 'pale'+'ale' handled in canonicalStyleFamily
  { family: 'Wheat', keywords: ['weizen', 'hefeweizen', 'witbier', 'wit', 'pszeniczne', 'pszenica', 'pszeniczny', 'wheat'] },
  { family: 'Lager', keywords: ['lager', 'pils', 'pilsner', 'lezak', 'helles', 'dunkel', 'vienna', 'marzen', 'desitka'] },
  { family: 'Bock', keywords: ['bock'] },
  { family: 'Barleywine', keywords: ['barleywine', 'barley'] },
];

export function canonicalStyleFamily(style: string | null): string {
  if (style == null) return OTHER_FAMILY;
  const tokens = new Set(baseNormalize(style).split(' ').filter(Boolean));
  if (tokens.size === 0) return OTHER_FAMILY;
  for (const rule of FAMILY_RULES) {
    if (rule.family === 'Pale Ale') {
      if (tokens.has('apa') || (tokens.has('pale') && tokens.has('ale'))) return 'Pale Ale';
      continue;
    }
    if (rule.keywords.some((k) => tokens.has(k))) return rule.family;
  }
  return OTHER_FAMILY;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/domain/style-family.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/domain/normalize.ts src/domain/style-family.ts src/domain/style-family.test.ts
git commit -m "feat(style-family): canonicalStyleFamily — keyword-rule style canonicalization"
```

---

## Task 2: switch `topStyleFamilies` + `filterInteresting`, delete `familyOf`

**Files:**
- Modify: `src/domain/filters.ts`
- Modify: `src/domain/filters.test.ts`

- [ ] **Step 1: Update the tests first (drop `familyOf`, keep the rest)**

In `src/domain/filters.test.ts`, change the import line:

```typescript
import { filterInteresting, rankByRating, familyOf, topStyleFamilies, ABV_BUCKETS, bucketForRange } from './filters';
```

to (remove `familyOf`):

```typescript
import { filterInteresting, rankByRating, topStyleFamilies, ABV_BUCKETS, bucketForRange } from './filters';
```

Then delete the entire `familyOf` test block:

```typescript
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

(The `topStyleFamilies` and `filterInteresting` "by family" tests stay — their `'IPA - American'` / `'Stout - Imperial'` inputs canonicalize to `IPA`/`Sour`/`Lager`/`Stout`, so the expectations still hold.)

- [ ] **Step 2: Run the filters test (sanity — still green)**

Run: `npx jest src/domain/filters.test.ts`
Expected: PASS — Step 1 only deleted the `familyOf` block; the remaining tests still pass against the unchanged `filters.ts`. This is a refactor (behavior-preserving), so the meaningful verification is Step 4 (tests stay green *after* the call-site swap). Proceed to Step 3.

- [ ] **Step 3: Edit `filters.ts` — import, replace both call sites, delete `familyOf`**

In `src/domain/filters.ts`, add the import at the top (after the existing imports/interfaces, before `familyOf`):

```typescript
import { canonicalStyleFamily } from './style-family';
```

Delete the `familyOf` function entirely:

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

In `topStyleFamilies`, replace the counting loop:

```typescript
  const counts = new Map<string, number>();
  for (const s of currentTapStyles) {
    const fam = familyOf(s);
    if (fam == null) continue;
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
  }
```

with:

```typescript
  const counts = new Map<string, number>();
  for (const s of currentTapStyles) {
    const fam = canonicalStyleFamily(s);
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
  }
```

In `filterInteresting`, replace the style branch:

```typescript
    if (opts.styles && opts.styles.length) {
      const fam = familyOf(t.style);
      if (fam == null || !opts.styles.some((x) => x.toLowerCase() === fam.toLowerCase())) {
        return false;
      }
    }
```

with:

```typescript
    if (opts.styles && opts.styles.length) {
      const fam = canonicalStyleFamily(t.style);
      if (!opts.styles.some((x) => x.toLowerCase() === fam.toLowerCase())) {
        return false;
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/domain/filters.test.ts`
Expected: PASS — all tests (topStyleFamilies counting, family-equality, ABV, rank).

- [ ] **Step 5: Verify nothing else references `familyOf`**

Run: `grep -rn "familyOf" src/`
Expected: no output (zero matches).

- [ ] **Step 6: Commit**

```bash
git add src/domain/filters.ts src/domain/filters.test.ts
git commit -m "refactor(filters): use canonicalStyleFamily, remove familyOf"
```

---

## Task 3: i18n key `filters.family_other`

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`, `src/i18n/locales/en.ts`

No Jest test; `npm run typecheck` enforces that every locale provides the key.

- [ ] **Step 1: Add the key to `Messages`**

In `src/i18n/types.ts`, in the `// filters` block, add after `'filters.any': string;`:

```typescript
  'filters.family_other': string;        // localized label for the Other style bucket
```

- [ ] **Step 2: Add to `uk.ts`**

In `src/i18n/locales/uk.ts`, in the `// filters` block, add after the `'filters.any':` line:

```typescript
  'filters.family_other': 'Інше',
```

- [ ] **Step 3: Add to `pl.ts`**

In `src/i18n/locales/pl.ts`, in the `// filters` block, add after the `'filters.any':` line:

```typescript
  'filters.family_other': 'Inne',
```

- [ ] **Step 4: Add to `en.ts`**

In `src/i18n/locales/en.ts`, in the `// filters` block, add after the `'filters.any':` line:

```typescript
  'filters.family_other': 'Other',
```

- [ ] **Step 5: Verify types (expected to FAIL here)**

Run: `npm run typecheck`
Expected: FAIL — `src/bot/keyboards.ts` / `src/bot/commands/filters.ts` don't yet reference the key, but the key itself is consistent; this step just confirms the locales compile. If PASS, good. Proceed to Task 4 regardless (no commit yet — committed with Task 4).

---

## Task 4: localized `Other` label in keyboard + summary

**Files:**
- Modify: `src/bot/keyboards.ts`
- Modify: `src/bot/commands/filters.ts`
- Modify: `src/bot/keyboards.test.ts`

- [ ] **Step 1: Write the failing keyboard test**

In `src/bot/keyboards.test.ts`, update the fake translator so it returns a label for the new key. Change:

```typescript
const t: Translator = (key) => (key === 'filters.reset_button' ? '♻️ Reset all' : String(key));
```

to:

```typescript
const t: Translator = (key) => {
  if (key === 'filters.reset_button') return '♻️ Reset all';
  if (key === 'filters.family_other') return 'Інше';
  return String(key);
};
```

(Distinct label `Інше`, deliberately different from the raw family `Other`, so the test is a true red before the localization is wired.)

Then append a new test:

```typescript
test('filtersKeyboard renders the Other family with its localized label, raw callback', () => {
  const kb = filtersKeyboard(t, {
    families: ['IPA', 'Other'],
    activeStyles: ['Other'],
    abvKey: null,
    minRating: null,
  });
  const all = buttons(kb);
  const other = all.find((b) => b.callback_data === 'style:Other')!;
  expect(other.text).toBe('✅ Інше'); // localized label, ✓ because active; callback stays style:Other
  expect(all.find((b) => b.callback_data === 'style:IPA')!.text).toBe('IPA');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/bot/keyboards.test.ts`
Expected: FAIL — current keyboard renders the raw family, so the button text is `✅ Other`, not `✅ Інше`.

- [ ] **Step 3: Localize `Other` in the keyboard**

In `src/bot/keyboards.ts`, add the import:

```typescript
import { OTHER_FAMILY } from '../domain/style-family';
```

Replace the style-row button construction:

```typescript
    const row = state.families.slice(i, i + 2).map((fam) => {
      const on = activeLc.has(fam.toLowerCase());
      return Markup.button.callback(on ? `✅ ${fam}` : fam, `style:${fam}`);
    });
```

with:

```typescript
    const row = state.families.slice(i, i + 2).map((fam) => {
      const on = activeLc.has(fam.toLowerCase());
      const label = fam === OTHER_FAMILY ? t('filters.family_other') : fam;
      return Markup.button.callback(on ? `✅ ${label}` : label, `style:${fam}`);
    });
```

- [ ] **Step 4: Localize `Other` in the summary line**

In `src/bot/commands/filters.ts`, add the import:

```typescript
import { topStyleFamilies, ABV_BUCKETS, bucketForRange } from '../../domain/filters';
import { OTHER_FAMILY } from '../../domain/style-family';
```

(The first line already exists — add only the `OTHER_FAMILY` import line beneath it.)

In `render`, replace the `stylesStr` line:

```typescript
  const stylesStr = f.styles.length ? f.styles.join(', ') : t('filters.any');
```

with:

```typescript
  const stylesStr = f.styles.length
    ? f.styles.map((s) => (s === OTHER_FAMILY ? t('filters.family_other') : s)).join(', ')
    : t('filters.any');
```

- [ ] **Step 5: Run the keyboard test + typecheck**

Run: `npx jest src/bot/keyboards.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit (includes Task 3 i18n)**

```bash
git add src/bot/keyboards.ts src/bot/keyboards.test.ts src/bot/commands/filters.ts src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts
git commit -m "feat(filters): localized Other family label in keyboard + summary"
```

---

## Task 5: update `spec.md`

**Files:**
- Modify: `spec.md`

No test. Keep the canonical spec in sync (CLAUDE.md rule).

- [ ] **Step 1: Update the `/filters` styles bullet**

In `spec.md` §4, the `/filters` section currently reads:

```
- **Стилі:** топ-10 родин (`familyOf` = частина Untappd-стилю до `" - "`),
  що є на кранах прямо зараз, ∪ активні родини користувача (multi-select).
  Матчинг — family-equality (`domain/filters.ts`), не substring.
```

Replace it with:

```
- **Стилі:** топ-10 канонічних родин, що є на кранах прямо зараз, ∪ активні
  родини користувача (multi-select). Канонізація — `canonicalStyleFamily`
  (`domain/style-family.ts`): нормалізація стилю + упорядкована keyword-таблиця
  правил (IPA/Stout/Porter перед Sour; Gose→Sour; Pils→Lager), fallback — родина
  `Other` (єдина локалізована мітка). Замінила прежню `familyOf`
  (prefix-before-`" - "`), хибну для вільнотекстових мультимовних стилів ontap.pl.
```

- [ ] **Step 2: Commit**

```bash
git add spec.md
git commit -m "docs(spec): /filters style families use canonicalStyleFamily"
```

---

## Task 6: final verification

**Files:** none (verification only).

- [ ] **Step 1: Type check**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — all suites, including the new `style-family` tests.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS — `tsc` emits to `dist/` with no errors.

- [ ] **Step 4: Confirm clean tree**

Run: `git status`
Expected: clean working tree (everything committed across Tasks 1–5).

---

## Self-Review

**Spec coverage** (design §2–§9):
- §2.1 keyword-rule engine, §3 family table/order → Task 1 (`FAMILY_RULES`, `canonicalStyleFamily`, all clusters tested).
- §2.2 IPA-wins priority, §3 Stout/Porter before Sour (`pastry`) → Task 1 tests (`Wheat IPA`→IPA, `Pastry Stout`→Stout, `Pastry Porter`→Porter).
- §2.3 Other fallback → Task 1 (`OTHER_FAMILY`, null/''/unmatched tests).
- §2.4 Gose→Sour → Task 1 test.
- §2.5 only Other localized → Task 3 (i18n key) + Task 4 (keyboard + summary).
- §4 replace familyOf at both call sites, delete it → Task 2 (+ grep guard).
- §3 Pale Ale special-case (`apa` OR `pale`+`ale`), Pale Lager→Lager → Task 1 test.
- §3 `desitka`→Lager → Task 1 Lager test.
- §6 edge cases (diacritics, stale selections, Other) → Task 1 (diacritics `Svetlý Ležák`); stale selections need no code (union-with-active already surfaces them — unchanged behavior).
- §7 tests → Tasks 1, 2, 4 ship them; Task 6 runs the suite.
- §9 spec.md update → Task 5.

**Placeholder scan:** none — every code step shows complete code; every run step shows command + expected result.

**Type consistency:** `canonicalStyleFamily(style: string | null): string` and `OTHER_FAMILY = 'Other'` are used identically in Tasks 1, 2 (filters), and 4 (keyboards import, commands import). `FAMILY_RULES` family strings (`'IPA'`, `'Stout'`, …, `'Pale Ale'`, `'Other'`) match the callback/storage values used by the keyboard (`style:${fam}`) and the summary mapping. `baseNormalize` is exported in Task 1 Step 3 and consumed in Task 1 Step 4. The i18n key `filters.family_other` is declared (Task 3 Step 1) and consumed (Task 4 Steps 3–4) with matching spelling.
