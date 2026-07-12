# Curated brewery-alias layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a finite, hand-curated brewery-alias equivalence layer so known-alias breweries (e.g. `nepomucen`↔`nepo`) pass the brewery hard-gate, shared by both the local catalog matcher and the server Untappd lookup, plus a documented triage path to grow the list.

**Architecture:** A new data module `src/domain/brewery-aliases.ts` holds symmetric, non-transitive alias pairs and exposes `aliasNeighbors(normForm)`. `breweryAliases()` in `matcher.ts` does one hop of expansion using it, so both call sites (`matchPrepared`, `lookupBeer`) inherit the equivalence with no other code change. A `scripts/brewery-alias-key.ts` helper prints the correct normalized pair from two raw labels for low-friction triage additions.

**Tech Stack:** TypeScript (CommonJS), Vitest, tsx for the helper script.

**Design spec:** `docs/superpowers/specs/2026-06-26-curated-brewery-aliases-design.md`

---

## File Structure

- **Create** `src/domain/brewery-aliases.ts` — curated pairs + `aliasNeighbors()`. Single responsibility: the alias data and its lookup map.
- **Create** `src/domain/brewery-aliases.test.ts` — unit tests for `aliasNeighbors` (symmetry, non-transitivity, unknown → `[]`).
- **Modify** `src/domain/matcher.ts` — `breweryAliases()` expands one hop via `aliasNeighbors`.
- **Modify** `src/domain/matcher.test.ts` — positive gate cases per issue example + negative guards.
- **Create** `scripts/brewery-alias-key.ts` — CLI helper printing the pair literal.
- **Create** `scripts/brewery-alias-key.test.ts` — test the pure formatter.
- **Modify** `package.json` — add `alias-key` npm script.
- **Modify** `docs/debug-orphan-matching.md` — split brewery-gate subclass + "how to add an alias" section.
- **Modify** `spec.md` — document curated layer under §4 brewery-gate narrative.

---

## Task 1: Curated alias data module

**Files:**
- Create: `src/domain/brewery-aliases.ts`
- Test: `src/domain/brewery-aliases.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/brewery-aliases.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { aliasNeighbors } from './brewery-aliases';

describe('aliasNeighbors', () => {
  test('returns direct partners symmetrically', () => {
    expect(aliasNeighbors('nepomucen')).toContain('nepo');
    expect(aliasNeighbors('nepo')).toContain('nepomucen');
    expect(aliasNeighbors('hopbrook')).toContain('hop brook');
    expect(aliasNeighbors('hop brook')).toContain('hopbrook');
    expect(aliasNeighbors('starkaft')).toContain('starkraft');
    expect(aliasNeighbors('starkraft')).toContain('starkaft');
    expect(aliasNeighbors('weihenstephaner')).toContain('bayerische staatsbrauerei weihenstephan');
    expect(aliasNeighbors('bayerische staatsbrauerei weihenstephan')).toContain('weihenstephaner');
  });

  test('kasteel vanhonsebrouck pairs with both van honsebrouck and bacchus', () => {
    expect(aliasNeighbors('kasteel vanhonsebrouck').sort()).toEqual(
      ['bacchus', 'van honsebrouck'],
    );
    expect(aliasNeighbors('van honsebrouck')).toEqual(['kasteel vanhonsebrouck']);
    expect(aliasNeighbors('bacchus')).toEqual(['kasteel vanhonsebrouck']);
  });

  test('is non-transitive: van honsebrouck and bacchus are not neighbors', () => {
    expect(aliasNeighbors('van honsebrouck')).not.toContain('bacchus');
    expect(aliasNeighbors('bacchus')).not.toContain('van honsebrouck');
  });

  test('unknown form returns empty array', () => {
    expect(aliasNeighbors('pinta')).toEqual([]);
    expect(aliasNeighbors('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/brewery-aliases.test.ts`
Expected: FAIL — cannot find module `./brewery-aliases`.

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/brewery-aliases.ts`:

```ts
// Finite, hand-curated brewery equivalences for the brewery hard-gate (#202).
// Each entry is a pair of NORMALIZED brewery forms (exactly what
// normalizeBrewery() produces — verify new entries with scripts/brewery-alias-key.ts).
// The map is symmetric but NON-TRANSITIVE: only the listed pairs match, so two
// forms that share a partner (van honsebrouck & bacchus both pair with kasteel
// vanhonsebrouck) do NOT thereby become equivalent to each other.
//
// This is a deliberately small, explicit list. Do NOT add fuzzy/general brewery
// matching here. Grow it only from confirmed orphan-triage misses, one reviewed
// pair at a time (see docs/debug-orphan-matching.md).
const ALIAS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['nepomucen', 'nepo'],
  ['van honsebrouck', 'kasteel vanhonsebrouck'],
  ['kasteel vanhonsebrouck', 'bacchus'],
  ['weihenstephaner', 'bayerische staatsbrauerei weihenstephan'],
  ['hopbrook', 'hop brook'],
  ['starkaft', 'starkraft'],
];

// normForm -> directly-paired forms. Built once at module load.
const NEIGHBORS: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  const add = (k: string, v: string) => {
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    if (!arr.includes(v)) arr.push(v);
  };
  for (const [a, b] of ALIAS_PAIRS) {
    add(a, b);
    add(b, a);
  }
  return m;
})();

// Directly-paired curated partners of a normalized brewery form (empty if none).
export function aliasNeighbors(normForm: string): string[] {
  return NEIGHBORS.get(normForm) ?? [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/brewery-aliases.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/brewery-aliases.ts src/domain/brewery-aliases.test.ts
git commit -m "feat(matcher): curated brewery-alias data module (#202)"
```

---

## Task 2: Expand `breweryAliases()` one hop

**Files:**
- Modify: `src/domain/matcher.ts` (import + `breweryAliases`, ~L1-2 and L136-156)
- Test: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/domain/matcher.test.ts` inside the existing `describe('breweryAliases', ...)` block (it imports `breweryAliases`, `breweryAliasesMatch` already at the top — confirm; if not, extend the import):

```ts
  test('expands curated aliases one hop (#202)', () => {
    expect(breweryAliases('Nepomucen Brewery').sort()).toEqual(['nepo', 'nepomucen']);
    expect(breweryAliases('Nepo Brewing').sort()).toEqual(['nepo', 'nepomucen']);
    expect(breweryAliases('Hopbrook Brewery').sort()).toEqual(['hop brook', 'hopbrook']);
    expect(breweryAliases('Starkaft Brewery').sort()).toEqual(['starkaft', 'starkraft']);
  });

  test('curated expansion leaves non-aliased breweries untouched', () => {
    expect(breweryAliases('Pinta')).toEqual(['pinta']);
  });
```

And add a new describe block for the end-to-end gate effect (the real acceptance criteria), near the existing `breweryAliasesMatch` tests:

```ts
describe('curated brewery-alias gate (#202)', () => {
  const passes = (shop: string, untappd: string) =>
    breweryAliasesMatch(breweryAliases(shop), breweryAliases(untappd));

  test('known-alias pairs now pass the brewery gate', () => {
    expect(passes('Nepomucen Brewery', 'Nepo Brewing')).toBe(true);
    expect(passes('Brouwerij Van Honsebrouck Brewery', 'Kasteel Brouwerij Vanhonsebrouck')).toBe(true);
    expect(passes('Bacchus Brewery', 'Kasteel Brouwerij Vanhonsebrouck')).toBe(true);
    expect(passes('Weihenstephaner Brewery', 'Bayerische Staatsbrauerei Weihenstephan')).toBe(true);
    expect(passes('Hopbrook Brewery', 'Hop Brook')).toBe(true);
    expect(passes('Starkaft Brewery', 'Starkraft')).toBe(true);
  });

  test('non-transitive: van honsebrouck does not gate-match a bacchus brewery', () => {
    expect(passes('Brouwerij Van Honsebrouck Brewery', 'Bacchus Brewery')).toBe(false);
  });

  test('unrelated breweries still rejected', () => {
    expect(passes('Pinta', 'Harpagan')).toBe(false);
    expect(passes('Nepomucen Brewery', 'Pinta')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/matcher.test.ts -t "202"`
Expected: FAIL — `breweryAliases('Nepomucen Brewery')` returns `['nepomucen']`, gate cases return `false`.

- [ ] **Step 3: Implement the one-hop expansion**

In `src/domain/matcher.ts`, add the import (line 2 area, after the existing imports):

```ts
import { aliasNeighbors } from './brewery-aliases';
```

Then modify `breweryAliases` (currently L136-156) to expand before returning. Replace the final `return Array.from(aliases);` with one-hop expansion:

```ts
export function breweryAliases(brewery: string): string[] {
  const aliases = new Set<string>();
  const full = normalizeBrewery(brewery);
  if (full) aliases.add(full);

  const collabParts = COLLAB_SEP.test(brewery) ? brewery.split(COLLAB_SEP) : [brewery];
  for (const part of collabParts) {
    const parenMatch = part.match(/^(.+?)\s*\((.+)\)\s*$/);
    if (parenMatch) {
      const outer = normalizeBrewery(parenMatch[1]);
      const inner = normalizeBrewery(parenMatch[2]);
      if (outer) aliases.add(outer);
      if (inner) aliases.add(inner);
    } else {
      const norm = normalizeBrewery(part);
      if (norm) aliases.add(norm);
    }
  }

  // One hop of curated-alias expansion (#202): union the direct partners of each
  // alias built above. Snapshot first so we expand only the normalized forms, not
  // their newly-added partners (non-transitive by construction).
  for (const a of Array.from(aliases)) {
    for (const n of aliasNeighbors(a)) aliases.add(n);
  }

  return Array.from(aliases);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/matcher.test.ts -t "202"`
Expected: PASS.

- [ ] **Step 5: Run the full matcher + lookup suites (regression guard)**

Run: `npx vitest run src/domain/matcher.test.ts src/domain/untappd-lookup.test.ts`
Expected: PASS — all existing tests still green (the existing `breweryAliases` exact-equality assertions for non-aliased breweries like `pinta`, `piwne podziemie` are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "feat(matcher): expand breweryAliases via curated layer (#202)"
```

---

## Task 3: Triage helper script

**Files:**
- Create: `scripts/brewery-alias-key.ts`
- Test: `scripts/brewery-alias-key.test.ts`
- Modify: `package.json` (scripts block, L6-12)

- [ ] **Step 1: Write the failing test**

Create `scripts/brewery-alias-key.test.ts`. Keep the formatting logic pure and exported so it is testable without spawning a process:

```ts
import { describe, test, expect } from 'vitest';
import { formatAliasPair } from './brewery-alias-key';

describe('formatAliasPair', () => {
  test('prints a paste-ready normalized pair literal', () => {
    expect(formatAliasPair('Brouwerij Van Honsebrouck Brewery', 'Kasteel Brouwerij Vanhonsebrouck'))
      .toBe("['van honsebrouck', 'kasteel vanhonsebrouck'],");
  });

  test('normalizes both sides', () => {
    expect(formatAliasPair('Nepomucen Brewery', 'Nepo Brewing'))
      .toBe("['nepomucen', 'nepo'],");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/brewery-alias-key.test.ts`
Expected: FAIL — cannot find module `./brewery-alias-key`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/brewery-alias-key.ts`:

```ts
import { normalizeBrewery } from '../src/domain/normalize';

// Build a paste-ready ALIAS_PAIRS literal from two raw brewery labels.
export function formatAliasPair(shopLabel: string, untappdLabel: string): string {
  const a = normalizeBrewery(shopLabel);
  const b = normalizeBrewery(untappdLabel);
  return `['${a}', '${b}'],`;
}

// CLI: npx tsx scripts/brewery-alias-key.ts "<shop label>" "<untappd label>"
function main(argv: string[]): void {
  const [shop, untappd] = argv;
  if (!shop || !untappd) {
    console.error('Usage: npx tsx scripts/brewery-alias-key.ts "<shop label>" "<untappd label>"');
    process.exitCode = 1;
    return;
  }
  console.log(formatAliasPair(shop, untappd));
}

// Run only when invoked directly, not when imported by the test.
if (require.main === module) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/brewery-alias-key.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the CLI end-to-end**

Run: `npx tsx scripts/brewery-alias-key.ts "Hopbrook Brewery" "Hop Brook"`
Expected output (exactly): `['hopbrook', 'hop brook'],`

- [ ] **Step 6: Add the npm script**

In `package.json`, add to the `scripts` block:

```json
    "alias-key": "tsx scripts/brewery-alias-key.ts",
```

so the block reads:

```json
  "scripts": {
    "test": "vitest run",
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "alias-key": "tsx scripts/brewery-alias-key.ts"
  },
```

- [ ] **Step 7: Verify the npm script wrapper**

Run: `npm run -s alias-key -- "Starkaft Brewery" "Starkraft"`
Expected output (exactly): `['starkaft', 'starkraft'],`

- [ ] **Step 8: Commit**

```bash
git add scripts/brewery-alias-key.ts scripts/brewery-alias-key.test.ts package.json
git commit -m "feat(scripts): brewery-alias-key triage helper (#202)"
```

---

## Task 4: Runbook update

**Files:**
- Modify: `docs/debug-orphan-matching.md`

- [ ] **Step 1: Split the brewery-gate `matcher_bug` subclass**

In `docs/debug-orphan-matching.md`, in the "Підкласи `N, not_found`" list (~L59-71), the current first bullet covers only the tail-token case (#120). Replace that single **Хвостовий токен пивоварні** bullet with two bullets:

```markdown
- **Brewery-gate: хвостовий токен** — ярлик магазину є *хвостовим*, а не провідним
  префіксом справжньої пивоварні (`Staropolski` ⋢ `Kultowy Browar Staropolski`).
  Brewery hard-gate ловить лише провідний префікс. Issue #120. Код:
  `matcher.ts breweryAliasesMatch`/`tokenPrefix`, `untappd-lookup.ts` Stage 1.
- **Brewery-gate: відомий alias** — це **та сама пивоварня під іншою назвою/написанням**,
  а НЕ токен-префікс/хвостовий варіант: `Nepomucen` vs `Nepo`, `Van Honsebrouck` vs
  `Kasteel Vanhonsebrouck`, `Starkaft` vs `Starkraft`. Фікс — додати пару в curated-список
  (див. «Як додати brewery-alias» нижче). Issue #202. Код: `matcher.ts brewery-aliases.ts`.
```

- [ ] **Step 2: Update the Step-4 layer table**

In the Крок-4 table (~L108-114), the brewery-gate row currently reads:

```markdown
| **Brewery gate** | є кандидати, але brewery відсічено (хвостовий токен) | `src/domain/matcher.ts` (`breweryAliasesMatch`) — issue #120 |
```

Replace with two rows:

```markdown
| **Brewery gate (хвостовий токен)** | brewery відсічено, ярлик — хвостовий, не провідний префікс | `src/domain/matcher.ts` (`breweryAliasesMatch`) — issue #120 |
| **Brewery gate (відомий alias)** | brewery відсічено, та сама пивоварня під іншою назвою/написанням | `src/domain/brewery-aliases.ts` (curated пари) — issue #202 |
```

- [ ] **Step 3: Add the "how to add an alias" section**

Insert a new section immediately before "## Крок 5. Розмітка тріажу (admin API)":

```markdown
## Як додати brewery-alias (#202)

Коли тріаж показав **Brewery-gate: відомий alias** (та сама пивоварня під іншою
назвою/написанням, не хвостовий токен) — фікс це один рядок даних, а не зміна логіки матчера:

1. Дістань нормалізовану пару з двох сирих ярликів (магазин + Untappd):
   ```bash
   npm run -s alias-key -- "<ярлик магазину>" "<ярлик Untappd>"
   # напр.:  npm run -s alias-key -- "Nepomucen Brewery" "Nepo Brewing"
   # друкує готовий до вставки рядок:  ['nepomucen', 'nepo'],
   ```
2. Встав пару в масив `ALIAS_PAIRS` у `src/domain/brewery-aliases.ts`.
3. Додай позитивний тест-приклад у `src/domain/matcher.test.ts`
   (блок `curated brewery-alias gate (#202)`).
4. Прогони `npx vitest run src/domain/matcher.test.ts src/domain/brewery-aliases.test.ts`
   і відкрий PR. Рядок `enrich_failures` познач `matcher_bug` як звичайно — він
   само-видалиться після наступного успішного енричу.

> Список **скінченний і явний**: жодного загального/fuzzy-матчингу пивоварень.
> Додавай тільки підтверджені тріажем пари, по одній перевіреній парі. Пари
> **симетричні й нетранзитивні** — спільний партнер не робить два інші форми
> еквівалентними (`van honsebrouck` і `bacchus` обидва під `kasteel vanhonsebrouck`,
> але між собою не матчаться).
```

- [ ] **Step 4: Verify the doc renders / no broken refs**

Run: `grep -n "brewery-aliases.ts\|alias-key\|#202" docs/debug-orphan-matching.md`
Expected: matches in the two new subclass bullets, the layer table row, and the new section.

- [ ] **Step 5: Commit**

```bash
git add docs/debug-orphan-matching.md
git commit -m "docs: orphan runbook brewery-alias triage path (#202)"
```

---

## Task 5: Update `spec.md`

**Files:**
- Modify: `spec.md` (brewery-gate narrative under §4 `POST /match`, ~L665-673)

- [ ] **Step 1: Add the curated-layer paragraph**

In `spec.md`, immediately after the "**Brewery-gate як first-token індекс (продуктивність).**" paragraph (ends ~L673), insert:

```markdown
**Curated brewery-aliases (#202).** Поверх токен-префіксного гейта `breweryAliases()`
розширює набір аліасів на **один хоп** зі скінченного, вручну-курованого списку пар
нормалізованих форм пивоварень (`src/domain/brewery-aliases.ts`): напр. `nepomucen`↔`nepo`,
`van honsebrouck`↔`kasteel vanhonsebrouck`, `starkaft`↔`starkraft`. Пари **симетричні й
нетранзитивні** (спільний партнер не робить дві інші форми еквівалентними). Розширення лише
**ширшає пул кандидатів гейта** — стадія назви (key-перетин / fuzzy ≥0.85 із `nameTokensDiverge`)
усе одно має пройти, тож FP-ризик низький. Жодного загального/fuzzy-матчингу пивоварень; список
росте лише з підтверджених тріажем промахів (див. `docs/debug-orphan-matching.md`). Обидва місця
використання (`matchPrepared`, `lookupBeer`) успадковують розширення через `breweryAliases()`.
```

- [ ] **Step 2: Verify the edit landed**

Run: `grep -n "Curated brewery-aliases\|brewery-aliases.ts" spec.md`
Expected: one match in the matching narrative.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): document curated brewery-alias layer (#202)"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all suites PASS, including the new `brewery-aliases.test.ts`, `scripts/brewery-alias-key.test.ts`, and the #202 cases in `matcher.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Confirm acceptance criteria (manual checklist)**

- [ ] Focused tests cover all 6 issue examples (Task 2 gate block).
- [ ] Existing negative brewery-gate tests still pass (Task 2 Step 5; `harp`≠`harpagan`).
- [ ] No general fuzzy brewery matching added (data list only).
- [ ] Alias layer shared by server lookup + local catalog matching (both via `breweryAliases()`).

---

## Self-Review Notes

- **Spec coverage:** data module (T1) ✓, shared `breweryAliases` hook (T2) ✓, FP-safety preserved via untouched name stage (T2 regression run) ✓, helper script (T3) ✓, triage workflow + runbook (T4) ✓, spec.md (T5) ✓.
- **Type consistency:** `aliasNeighbors(normForm: string): string[]` defined in T1, imported/used in T2; `formatAliasPair(shopLabel, untappdLabel): string` defined and tested in T3. Names consistent across tasks.
- **Non-transitive invariant** is asserted in both T1 (`aliasNeighbors`) and T2 (gate level) — matches the spec's non-goal of transitive equivalence.
