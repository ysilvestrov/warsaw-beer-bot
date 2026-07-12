# ontap non-beer filtering (cocktail/wine/kombucha/schedule) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `isOntapNonBeerTap` to filter cocktail / wine / kombucha / schedule-pollution ontap rows using only `style` and `brewery_ref` (never the beer name), so they never become catalog orphans.

**Architecture:** Pure-function classifier `src/sources/ontap/non-beer.ts`. We only widen the existing token sets (`STYLE_TOKENS`, `BREWERY_TOKENS`) and add one `brewery_ref` schedule/nav guard. The evaluation order and the no-name-inspection invariant are unchanged.

**Tech Stack:** TypeScript (CommonJS), Vitest.

**Design spec:** `docs/superpowers/specs/2026-06-26-ontap-nonbeer-cocktail-wine-kombucha-design.md`

---

## File Structure

- **Modify** `src/sources/ontap/non-beer.ts` — add style tokens, brewery tokens, and the schedule/nav guard. Single responsibility unchanged.
- **Modify** `src/sources/ontap/non-beer.test.ts` — add filtered cases for the #208 rows; keep all existing eligible/invariant cases.
- **Modify** `spec.md` — extend the §5.2 "Ontap non-beer gate" category list (keep the no-name invariant wording).

Reference — current `non-beer.ts` shape (do not rewrite wholesale; make the targeted edits below):
- `STYLE_TOKENS` array (~L6), `ELIGIBLE_STYLE_TOKENS` (~L21), `EXACT_STYLE_PHRASES` (~L31), `BREWERY_TOKENS` (~L45), `EXACT_BREWERY_SENTINELS` (~L60), `norm()` (~L66), `isOntapNonBeerTap()` (~L70).
- `isOntapNonBeerTap` order: eligible-style → non-beer-style → non-beer-brewery → false.

---

## Task 1: Style-token additions (cocktail / nalewka / szprycer / kombucha / glera)

**Files:**
- Modify: `src/sources/ontap/non-beer.ts` (the `STYLE_TOKENS` array)
- Test: `src/sources/ontap/non-beer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these rows to the existing `test.each([...])('flags %s', ...)` filtered block in `src/sources/ontap/non-beer.test.ts` (the block whose assertion is `toBe(true)`):

```ts
    ['style cocktail english', { style: 'Cocktail', brewery_ref: 'Nalej Se Brewery', beer_ref: 'Mai Tai' }],
    ['style cocktail english 2', { style: 'Cocktail', brewery_ref: 'Nalej Se Brewery', beer_ref: 'Bramble' }],
    ['style nalewka', { style: 'Nalewka', brewery_ref: 'Nalej Se Brewery', beer_ref: 'Nalewka gruszkowa' }],
    ['style szprycer', { style: 'Szprycer', brewery_ref: 'Nalej Se Brewery', beer_ref: 'Big Diva' }],
    ['style kombucha', { style: 'Kombucha', brewery_ref: 'Koko Kombucha Brewery', beer_ref: 'Imbir' }],
    ['style wine grapes glera', { style: 'Chardonnay, Glera and Garganega', brewery_ref: 'Cantina della Valle', beer_ref: 'Vino Bianco Frizzante' }],
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sources/ontap/non-beer.test.ts -t "style cocktail english"`
Expected: FAIL — `isOntapNonBeerTap` returns false (tokens not yet present).

- [ ] **Step 3: Implement — extend `STYLE_TOKENS`**

In `src/sources/ontap/non-beer.ts`, add the five tokens to the `STYLE_TOKENS` array (append before the closing `]`):

```ts
const STYLE_TOKENS = [
  'vino',
  'wino',
  'wina',
  'prosecco',
  'frizzante',
  'spritz',
  'aperitivo',
  'koktajl',
  'cocktail',
  'nalewka',
  'szprycer',
  'kombucha',
  'glera',
  'musujące',
  'wytrawne',
  'półwytrawne',
  'słodkie',
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sources/ontap/non-beer.test.ts`
Expected: PASS — the new style rows flag true; all existing cases (cider/kvass/mead eligible, normal beer, `does not inspect beer_ref/name`) still pass.

- [ ] **Step 5: Commit**

```bash
git add src/sources/ontap/non-beer.ts src/sources/ontap/non-beer.test.ts
git commit -m "feat(ontap): filter cocktail/nalewka/szprycer/kombucha/glera styles (#208)"
```

---

## Task 2: Brewery-token additions (aperitivo / cantina / kombucha)

**Files:**
- Modify: `src/sources/ontap/non-beer.ts` (the `BREWERY_TOKENS` array)
- Test: `src/sources/ontap/non-beer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the same `'flags %s'` (`toBe(true)`) block — these are the null-style rows caught via brewery:

```ts
    ['brewery aperitivo with suffix', { style: null, brewery_ref: 'Aperitivo Spritz Brewery', beer_ref: 'Aperol Spritz' }],
    ['brewery cantina singular', { style: null, brewery_ref: 'Cantina della Valle Brewery', beer_ref: 'Glera Trevenezie' }],
    ['brewery cantina no suffix', { style: null, brewery_ref: 'Cantina della Valle', beer_ref: 'Vino Bianco Frizzante' }],
    ['brewery kombucha null style', { style: null, brewery_ref: 'Koko Kombucha Brewery', beer_ref: 'Imbir' }],
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sources/ontap/non-beer.test.ts -t "brewery aperitivo with suffix"`
Expected: FAIL — brewery tokens not yet present (exact sentinel `aperitivo spritz` misses the ` Brewery` suffix).

- [ ] **Step 3: Implement — extend `BREWERY_TOKENS`**

In `src/sources/ontap/non-beer.ts`, append three tokens to the `BREWERY_TOKENS` array:

```ts
const BREWERY_TOKENS = [
  'wino',
  'wine',
  'winiarska',
  'maccari',
  'frizzanti',
  'cantine',
  'cantina',
  'san martino',
  'conegliano',
  'puglia',
  'vini',
  'dolium vini',
  'stacja winiarska',
  'aperitivo',
  'kombucha',
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sources/ontap/non-beer.test.ts`
Expected: PASS — all four new brewery rows flag true; existing cases unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/sources/ontap/non-beer.ts src/sources/ontap/non-beer.test.ts
git commit -m "feat(ontap): filter aperitivo/cantina/kombucha breweries (#208)"
```

---

## Task 3: Schedule / navigation pollution guard

**Files:**
- Modify: `src/sources/ontap/non-beer.ts` (new helper + brewery branch in `isOntapNonBeerTap`)
- Test: `src/sources/ontap/non-beer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add the filtered case to the `'flags %s'` (`toBe(true)`) block:

```ts
    ['schedule pollution brewery', { style: null, brewery_ref: 'Basement -> Czwartek-Sobota od 18.00 Brewery', beer_ref: 'Bar' }],
```

And add a negative regression case to the `'keeps %s eligible'` (`toBe(false)`) block, to prove the guard is narrow:

```ts
    ['normal brewery with dash but no arrow/time', { style: 'IPA', brewery_ref: 'Browar Stu Mostow - Wroclaw' }],
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sources/ontap/non-beer.test.ts -t "schedule pollution brewery"`
Expected: FAIL — the schedule-string brewery returns false (no guard yet).

- [ ] **Step 3: Implement — add the guard helper and wire it into the brewery branch**

In `src/sources/ontap/non-beer.ts`, add this helper immediately after the `norm` function:

```ts
// Parser pollution: a brewery_ref that is actually a schedule / navigation
// breadcrumb (e.g. "Basement -> Czwartek-Sobota od 18.00 Brewery"), never a real
// brewery. Conservative signals: a "->" nav arrow, or an opening-hours time range
// like "od 18.00".
function looksLikeScheduleOrNav(brewery: string): boolean {
  return brewery.includes('->') || /\bod\s+\d{1,2}[.:]\d{2}\b/.test(brewery);
}
```

Then extend the brewery condition inside `isOntapNonBeerTap` (the existing block):

```ts
  const brewery = norm(tap.brewery_ref);
  if (
    brewery &&
    (EXACT_BREWERY_SENTINELS.has(brewery) ||
      BREWERY_TOKENS.some((token) => brewery.includes(token)) ||
      looksLikeScheduleOrNav(brewery))
  ) {
    return true;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sources/ontap/non-beer.test.ts`
Expected: PASS — schedule-string brewery flags true; the `- Wroclaw` dash brewery stays eligible (no `->`, no time); all prior cases unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/sources/ontap/non-beer.ts src/sources/ontap/non-beer.test.ts
git commit -m "feat(ontap): guard schedule/navigation pollution breweries (#208)"
```

---

## Task 4: Update `spec.md`

**Files:**
- Modify: `spec.md` (§5.2 "Ontap non-beer gate", ~L841-846)

- [ ] **Step 1: Extend the category list (keep the no-name invariant wording)**

In `spec.md`, replace the first sentence of the "Ontap non-beer gate" bullet:

```markdown
- **Ontap non-beer gate.** `refreshOntap` ПОВИНЕН відкидати очевидні не-пивні
  крани (wine/prosecco/frizzante/spritz/cocktails) **до** створення snapshot/tap
```

with (adds the new categories + schedule-pollution guard; the `style`/`brewery_ref`-only and name-not-used sentences that follow stay unchanged):

```markdown
- **Ontap non-beer gate.** `refreshOntap` ПОВИНЕН відкидати очевидні не-пивні
  крани (wine/prosecco/frizzante/spritz/cocktails/nalewka/szprycer/kombucha, а також
  brewery_ref-сміття парсера — schedule/nav рядки на кшталт `-> … od 18.00`) **до**
  створення snapshot/tap
```

- [ ] **Step 2: Verify the edit landed**

Run: `grep -n "kombucha\|szprycer\|od 18" spec.md`
Expected: a match in the §5.2 non-beer-gate bullet.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): extend ontap non-beer gate categories (#208)"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all suites PASS, including the new `non-beer.test.ts` filtered rows and the unchanged eligible/invariant cases.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Confirm acceptance criteria (manual checklist)**

- [ ] All 8 #208 example rows are covered by a filtered (`toBe(true)`) test (Tasks 1-3).
- [ ] Existing cider/kvass/mead eligible tests still green (Task 1/2/3 Step 4; Task 5 Step 1).
- [ ] Classifier still does not inspect `beer_ref` — the `does not inspect beer_ref/name` test (`Vino Merlot Spritz Prosecco`) stays green.
- [ ] No name-based rule added; only `style` + `brewery_ref` signals.

---

## Self-Review Notes

- **Spec coverage:** style tokens (T1) ✓, brewery tokens incl. aperitivo-suffix fix (T2) ✓, schedule/nav guard (T3) ✓, eligible precedence preserved (unchanged order; verified in T1-3 Step 4) ✓, no name inspection (invariant test kept) ✓, spec.md (T4) ✓.
- **All 8 issue rows mapped:** Mai Tai/Bramble/Jagermeister → `Cocktail` style (T1); Nalewka gruszkowa → `Nalewka` (T1); Big Diva → `Szprycer` (T1); Imbir → `Kombucha` style + `kombucha` brewery (T1/T2); Vino Bianco Frizzante → `glera` style + `cantina` brewery (T1/T2); Aperol Spritz / Aperitivo Spritz → `aperitivo` brewery (T2); Glera Trevenezie → `cantina` brewery (T2); `Basement -> … od 18.00` → schedule guard (T3).
- **Type consistency:** `looksLikeScheduleOrNav(brewery: string): boolean` defined and used in T3; token arrays are the existing `string[]`. Test objects may carry an extra `beer_ref` field — structurally fine, the function ignores it (proves no name inspection).
