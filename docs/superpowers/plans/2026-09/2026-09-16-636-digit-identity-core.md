# #636 Digit Identity — Core (module + matcher) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One digit-identity rule (`src/domain/digit-identity.ts`) and the matcher's exact and fuzzy stages obeying it, so a tap or shop card never links to another number or vintage of the same series.

**Architecture:** A dependency-free domain module reads the digits of a raw beer name into typed buckets (hard numbers, soft grade-like numbers, degree grades, versions, years) and compares two readings as `same` / `year-fallback` / `different`. `matchPrepared` filters its exact hits and gates its best fuzzy hit with it. Nothing about `normalizeName`, `normalized_name` or Algolia queries changes; no migration.

**Tech Stack:** TypeScript (CommonJS, Node 24), Vitest (globals), better-sqlite3 (only in the throwaway verification scripts).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-16-636-digit-identity-design.md` — read «Читання цифр», «Правило», «Застосування → Ядро» before starting. The code below was run against a copy of the repo while writing this plan; where the code and this plan disagree, **the code in the repo beats the plan** — stop and report instead of forcing the plan.

## Global Constraints

- This plan is the **core stage only**. The periphery (`ensureBeerRow`, `ensureOrphan`/`resolvableOrphan`, `lookupBeer`, `spec.md`) gets its own plan **after** the core's end-to-end review. **Do not deploy and do not open a PR after this plan** — spec «Порядок деплою»: core without the lookup gate makes wrong links durable.
- Module name is `digit-identity.ts`. `src/domain/name-identity.ts` already exists (#505) — do not touch it.
- `numericTokensCompatible`, `extractYear` and `normalizeName` stay as they are in this stage (`extractYear` is still used by `untappd-lookup.ts` and `name-identity.test.ts`).
- Soft range is `8–14`, deliberately **not** `GRADE_MIN`/`GRADE_MAX` (7–20) from `czech-grade.ts`.
- Full gate after **every** task: `npm test && npm run typecheck` (never a scoped run as the gate).
- Run Vitest on explicit paths from the worktree root (`npx vitest run src/domain/...`); never `--root /`.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Commit messages name the mechanism.
- Code comments follow the file's language: `matcher.ts` comments are English.

## Setup (controller, before Task 1)

- [ ] Create the worktree from `origin/main` (branch `636-digit-identity`), then bring the docs in:

```bash
git cherry-pick b0da769 8488416   # spec + spec fixes from branch spec/636-digit-identity
git cherry-pick <plan commit: git log -1 --format=%h spec/636-digit-identity -- docs/superpowers/plans>
npm install
npm test && npm run typecheck      # baseline must be green before Task 1
```

## File Structure

| file | responsibility |
|---|---|
| `src/domain/digit-identity.ts` (create) | read a name's digits; compare two readings. No imports. |
| `src/domain/digit-identity.test.ts` (create) | the measured rule, one real pair per rule |
| `src/domain/matcher.ts` (modify) | exact stage filters by digit identity; fuzzy stage gates the best hit |
| `src/domain/matcher.test.ts` (modify) | #636 fuzzy + exact tests; one vintage test deliberately changed |
| `~/warsaw-beer-probes/636/verify-module.ts` (exists, outside git) | module vs measured prototype, pair by pair, on the prod DB |
| `~/warsaw-beer-probes/636/replay-ingest-links.ts` (exists, outside git) | what the next ingest would change on live tap links |

Task sizing (CLAUDE.md): Tasks 1–3 each carry their complete code, touch one source file plus its test, and need no new decision → **small, executed inline by the controller**. Task 4 is the dispatched end-to-end review and must name Tasks 1–3 as inline tasks.

---

### Task 1: `digit-identity.ts` — read and compare the digits of a name

**Files:**
- Create: `src/domain/digit-identity.ts`
- Test: `src/domain/digit-identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface NameDigits { numbers: string[]; soft: string[]; grades: string[]; versions: string[]; years: string[] }` (every array sorted)
  - `export type DigitIdentity = 'same' | 'year-fallback' | 'different'`
  - `export function readNameDigits(name: string): NameDigits`
  - `export function digitIdentity(a: NameDigits, b: NameDigits): DigitIdentity`

- [ ] **Step 1: Write the failing test** — create `src/domain/digit-identity.test.ts`:

```ts
import { digitIdentity, readNameDigits, type DigitIdentity } from './digit-identity';

// #636. Every pair below is a real catalog or tap name from the prod probe (spec 2026-09-16), so a rule change
// that "looks harmless" has to explain which measured beer it moves.
const identity = (a: string, b: string): DigitIdentity => digitIdentity(readNameDigits(a), readNameDigits(b));

describe('readNameDigits', () => {
  test('a hash number is hard, the degree grade is kept apart', () => {
    expect(readNameDigits('Dr.Hazy #7 15°')).toEqual({
      numbers: ['7'], soft: [], grades: ['15'], versions: [], years: [],
    });
  });

  test('ABV with its mid-dot tail never becomes a number', () => {
    expect(readNameDigits('Buzdygan Rozkoszy 24°·8,5%')).toEqual({
      numbers: [], soft: [], grades: ['24'], versions: [], years: [],
    });
  });

  test('a year range inside brackets yields both years', () => {
    expect(readNameDigits('Piece of Cake (2015-2022)').years).toEqual(['2015', '2022']);
  });

  test('a v-prefixed decimal is a version', () => {
    expect(readNameDigits('Bloody Mary v1.0').versions).toEqual(['1.0']);
  });

  test('an unmarked 19 is hard — outside the soft 8–14 range', () => {
    expect(readNameDigits('Juicy Trap 19').numbers).toEqual(['19']);
  });

  test('digits glued to a word are not read', () => {
    expect(readNameDigits('Black Celebration #3 WFP10 Edition').numbers).toEqual(['3']);
  });

  test("an apostrophe year after the number is a year, the slash pair stays numbers", () => {
    expect(readNameDigits("Hoppy Grodzisz 23' 2/20")).toMatchObject({ numbers: ['2', '20'], years: ['2023'] });
  });
});

describe('digitIdentity', () => {
  test.each<[string, string, DigitIdentity]>([
    // ABV in the apostrophe spelling is not a number
    ["Gose 4'8%", 'Gose', 'same'],
    // grades are soft: never split on their own …
    ['Pils 12°', 'Pils', 'same'],
    ['Białe IPA 16°', 'Białe IPA 14°', 'same'],
    // … but confirm a bare number on the other side …
    ['Otakar 11°', 'Otakar 11', 'same'],
    // … and a soft number that disagrees with the only grade is a different beer
    ['KONRAD 12°', 'Konrad Svetlé Výčepní 10', 'different'],
    // two-digit years
    ["Hoppiness'26", 'Hoppiness 2026', 'same'],
    ["Open Craft '26", 'Open Craft 2026 18°', 'same'],
    // years: equal sets, else different; one side only is a fallback
    ['Backwoods Bastard (2018)', 'Backwoods Bastard (2019)', 'different'],
    ['Backwoods Bastard', 'Backwoods Bastard (2018)', 'year-fallback'],
    ['Autonomia (2021/2022)', 'Autonomia (2022/2023)', 'different'],
    ['Affection (2025)', 'Affection 2025', 'same'],
    ['Echo 2026 10th Edition', 'ECHO the 10th Edition', 'year-fallback'],
    // markers and leading zeros
    ['Uwarzone z Wami #3', 'Uwarzone Z Wami vol.3: Polish Black IPA', 'same'],
    ['Barrel Aged Serie No.38', 'Barrel Aged Serie No.35', 'different'],
    ['SPECIMEN 002', 'Specimen 2', 'same'],
    ['SPECIMEN 002', 'Specimen 001', 'different'],
    // versions split only when both sides carry one
    ['SPOKO CYDR 2.0 (Zweigelt Edition)', 'Spoko Cydr Zweigelt Edition', 'same'],
    ['Ambrosia 9.0', 'Ambrosia 5.0', 'different'],
    // soft 8–14 without a marker
    ['Svijanský Máz 11', 'Svijanský Máz', 'same'],
    ['Trappistes Rochefort 8', 'Trappistes Rochefort 10', 'different'],
    ['Trappistes Rochefort 6', 'Trappistes Rochefort 10', 'different'],
    // hard numbers on one side only
    ['Paranormal Activity 2', 'Paranormal Activity', 'different'],
    ['Kronenbourg 1664', 'Kronenbourg', 'different'],
    ['Funky Monkey #2 12°', 'Funky Monkey', 'different'],
    ['Juicy Trap #19 18°', 'Juicy Trap #20', 'different'],
    // glued digits are not read (documented limit)
    ['BA23.03', 'BA23.02', 'same'],
    // documented cost: the grade does not cover the soft 10 of "10,5/10"
    ['Polska Desitka 10,5°', 'Polska Desitka 10,5/10', 'different'],
  ])('%s  ↔  %s  →  %s', (a, b, want) => {
    expect(identity(a, b)).toBe(want);
    expect(identity(b, a)).toBe(want); // the rule is symmetric
  });
});
```

- [ ] **Step 2: Run it — must fail**

Run: `npx vitest run src/domain/digit-identity.test.ts`
Expected: FAIL — `Cannot find module './digit-identity'` (or equivalent resolve error).

- [ ] **Step 3: Implement** — create `src/domain/digit-identity.ts`:

```ts
// #636: which digits of a beer name say WHICH beer it is.
//
// `normalizeName` drops every digit token and `stripSearchNoise` drops brackets (with their years) and
// degree grades (with their number), so two different beers of one series share a normalized key:
// `Juicy Trap #19` / `#20`, `Trappistes Rochefort 6` / `10`, `Stary Sad 2023` / `2025`. Every place that
// reads that key as identity asks this module instead of re-deriving digits on its own.
//
// The rules below are measured, not guessed (spec 2026-09-16-636-digit-identity-design.md, prototype over
// 1 658 known-different pairs, 55 known-same pairs and 1 494 live tap links).

export interface NameDigits {
  /** Hard numbers (`#7`, `vol.4`, `002` → `2`, `1664`): a leftover one on either side means a different beer. */
  numbers: string[];
  /** Unmarked integers 8–14 (`Svijanský Máz 11`): a Czech grade written without `°`; soft like a grade. */
  soft: string[];
  /** Degree grades (`12°`, `12,5°` → `12.5`): extract, not identity — they only confirm a number. */
  grades: string[];
  /** Release versions `N.0` (`Ambrosia 9.0`): tell beers apart only when both sides carry one. */
  versions: string[];
  /** Calendar years, including `'26` / `26'` → `2026` and both ends of `2015-2022`. */
  years: string[];
}

export type DigitIdentity = 'same' | 'year-fallback' | 'different';

// ABV in any spelling, incl. the apostrophe decimal ontap uses (`4'8%`). Removed first, so its digits are
// never read as numbers.
const ABV = /[<>]?\s*\d+(?:[.,'’]\d+)?\s*%/g;
const ABV_LABELLED = /\b\d+(?:[.,]\d+)?\s*abv\b/gi;
// A degree grade with an optional mid-dot ABV tail: `24°`, `12,5°·4`, `KONRAD 12*`.
const GRADE = /(\d+(?:[.,]\d+)?)\s*[°*](?:\s*[·•∙]\s*[<>]?\s*\d+(?:[.,'’]\d+)?\s*%?)?/gu;
const YEAR_APOSTROPHE_BEFORE = /(^|[\s(\[:\-]|\p{L})['’](\d{2})(?![\p{L}\p{N}])/gu;
const YEAR_APOSTROPHE_AFTER = /(?<![\p{L}\p{N}])(\d{2})['’](?=[\s):,\]\-]|$)/gu;
// A digit run not glued to a letter or digit (`WFP10`, `TAP04` are brand/batch codes, not numbers). A dot
// or comma before it is fine unless a digit precedes that (`vol.01` reads, `10.5` stays one token).
const NUMBER = /(?<![\p{L}\p{N}])(?<!\p{N}[.,])(v?)(\d+(?:[.,]\d+)?)(?:st|nd|rd|th)?(?![\p{L}\p{N}])/giu;
const MARKER_BEFORE = /(?:#|\b(?:no|nr|vol|batch|edition|part)\.?)\s*$/i;
const YEAR = /^(?:19|20)\d{2}$/;
const VERSION = /^\d+\.0$/;
// Measured range for an unmarked grade-like integer. Deliberately NOT czech-grade.ts GRADE_MIN/MAX (7–20):
// that range reads a grade once a name is known to be Czech; here any unmarked integer qualifies, and
// 15–20 are mostly series numbers (`Juicy Trap 19`).
const SOFT_MIN = 8;
const SOFT_MAX = 14;

function canon(raw: string): string {
  const [int, frac] = raw.replace(',', '.').split('.');
  const trimmed = int.replace(/^0+(?=\d)/, '');
  return frac === undefined ? trimmed : `${trimmed}.${frac}`;
}

export function readNameDigits(name: string): NameDigits {
  let s = name.replace(ABV, ' ').replace(ABV_LABELLED, ' ');
  const grades = [...s.matchAll(GRADE)].map((m) => canon(m[1]));
  s = s
    .replace(GRADE, ' ')
    .replace(YEAR_APOSTROPHE_BEFORE, '$1 20$2 ')
    .replace(YEAR_APOSTROPHE_AFTER, ' 20$1 ');

  const numbers: string[] = [];
  const soft: string[] = [];
  const versions: string[] = [];
  const years = new Set<string>();
  for (const m of s.matchAll(NUMBER)) {
    const value = canon(m[2]);
    const marked =
      MARKER_BEFORE.test(s.slice(0, m.index)) || /^0\d/.test(m[2]) || m[1] !== '';
    if (YEAR.test(value)) years.add(value);
    else if (VERSION.test(value)) versions.push(value);
    else if (!marked && /^\d+$/.test(value) && +value >= SOFT_MIN && +value <= SOFT_MAX) soft.push(value);
    else numbers.push(value);
  }
  return {
    numbers: numbers.sort(),
    soft: soft.sort(),
    grades: grades.sort(),
    versions: versions.sort(),
    years: [...years].sort(),
  };
}

// Multiset difference: every element of `xs` not paired off with an element of `ys`.
function minus(xs: readonly string[], ys: readonly string[]): string[] {
  const pool = [...ys];
  return xs.filter((x) => {
    const i = pool.indexOf(x);
    if (i === -1) return true;
    pool.splice(i, 1);
    return false;
  });
}

// A soft number on one side against a grade on the other, when the soft side is the only one carrying a
// number and it disagrees with the grade: `KONRAD 12°` vs `Konrad Svetlé Výčepní 10`.
function softContradictsGrade(x: NameDigits, y: NameDigits): boolean {
  return (
    x.soft.length > 0 &&
    y.soft.length === 0 &&
    y.grades.length > 0 &&
    !x.soft.some((n) => y.grades.includes(n))
  );
}

export function digitIdentity(a: NameDigits, b: NameDigits): DigitIdentity {
  // 1. Hard numbers must pair off; a leftover may be covered by a grade or soft number on the other side.
  if (minus(minus(a.numbers, b.numbers), [...b.grades, ...b.soft]).length > 0) return 'different';
  if (minus(minus(b.numbers, a.numbers), [...a.grades, ...a.soft]).length > 0) return 'different';
  // 2. Grades and soft numbers never split on their own — except where they are the only number carrier.
  if (a.soft.length > 0 && b.soft.length > 0 && a.soft.join(' ') !== b.soft.join(' ')) return 'different';
  if (softContradictsGrade(a, b) || softContradictsGrade(b, a)) return 'different';
  // 3. Versions split only when both sides carry one.
  if (a.versions.length > 0 && b.versions.length > 0 && a.versions.join(' ') !== b.versions.join(' ')) {
    return 'different';
  }
  // 4. Years: equal sets on both sides, or acceptable-if-nothing-better when only one side has any.
  if (a.years.length > 0 && b.years.length > 0) {
    return a.years.join(' ') === b.years.join(' ') ? 'same' : 'different';
  }
  if (a.years.length > 0 || b.years.length > 0) return 'year-fallback';
  return 'same';
}
```

- [ ] **Step 4: Run it — must pass**

Run: `npx vitest run src/domain/digit-identity.test.ts`
Expected: PASS, 34 tests (7 `readNameDigits` + 27 table rows).

- [ ] **Step 5: Mutation proof — each mutation must turn at least the named test red, then revert it**

| mutation in `digit-identity.ts` | test that must fail |
|---|---|
| delete `.replace(ABV, ' ')` (keep `.replace(ABV_LABELLED, ' ')`) | `Gose 4'8% ↔ Gose` |
| make `softContradictsGrade` return `false` | `KONRAD 12° ↔ Konrad Svetlé Výčepní 10` |
| remove `\|\p{L}` from `YEAR_APOSTROPHE_BEFORE` | `Hoppiness'26 ↔ Hoppiness 2026` |
| change `SOFT_MAX = 14` to `SOFT_MAX = 20` | `an unmarked 19 is hard` |
| replace the years block's `'different'` with `'same'` | `Backwoods Bastard (2018) ↔ (2019)` |
| delete the `versions` check | `Ambrosia 9.0 ↔ Ambrosia 5.0` |
| remove `(?<!\p{N}[.,])` from `NUMBER` | `a v-prefixed decimal is a version` or `Barrel Aged Serie No.38` |

Record which test went red for each; if a mutation turns nothing red, stop and report — the test is vacuous.

- [ ] **Step 6: Prove the module equals the measured rule on the prod DB** (read-only):

Run: `REPO=$PWD npx tsx ~/warsaw-beer-probes/636/verify-module.ts`
Expected (numbers can drift by a few only if prod data changed since 2026-09-16; the disagreement set must be exactly these two):
```
DISAGREE set1: Terroir Series: Kyiv'25  <->  Terroir Series: Kyiv  module=year-fallback proto=different
DISAGREE set1: SolidØl Teaninich'25  <->  Solidøl Teaninich 12  module=year-fallback proto=different
set1 1658 {"year-fallback":245,"same":147,"different":1266}
set2 55 {"same":52,"different":3}
set3 1494 {"same":1436,"different":27,"year-fallback":31}
disagreements 2
```
Any other `DISAGREE` line is a defect in this task, not in the prototype — stop and report.

- [ ] **Step 7: Full gate** — `npm test && npm run typecheck` → all green.

- [ ] **Step 8: Commit**

```bash
git add src/domain/digit-identity.ts src/domain/digit-identity.test.ts
git commit -m "feat(#636): one digit-identity rule — hard numbers, soft grades, versions and years read from the raw name

normalizeName drops every digit, so rows of one series share a key. The module reads
the digits once and compares two readings; the rule reproduces the prototype measured
on 1 658 known-different and 55 known-same prod pairs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: fuzzy stage — the best hit must not carry different digits

**Files:**
- Modify: `src/domain/matcher.ts` (imports at the top; the fuzzy tail of `matchPrepared`, right after `if (nameTokensDiverge(nn, best.item.nameNorm)) return null;`)
- Test: `src/domain/matcher.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `readNameDigits`, `digitIdentity` from Task 1.
- Produces: `matchPrepared` returns `null` instead of a fuzzy hit whose digits are `different` from the input. Signature unchanged.

- [ ] **Step 1: Write the failing tests** — append to `src/domain/matcher.test.ts` (it already defines the helper `c(...)` at the top):

```ts
describe('#636 fuzzy stage: the best hit must not carry different digits', () => {
  const przetwornia = (id: number, name: string) => c({ id, brewery: 'Przetwórnia Chmielu', name });
  const cat = [przetwornia(233, 'Przetwór #3'), przetwornia(900, 'Modernizm')];

  test('another number of the series is refused', () => {
    // Before #636: { id: 233, source: 'fuzzy' } — "przetwor mango" fuzzes onto "przetwor" at 0.82.
    expect(matchBeer({ brewery: 'Przetwórnia Chmielu Brewery', name: 'Przetwór #4 Mango' }, cat)).toBeNull();
  });

  test('control: the same number still fuzzes', () => {
    expect(matchBeer({ brewery: 'Przetwórnia Chmielu Brewery', name: 'Przetwór #3 Mango' }, cat))
      .toMatchObject({ id: 233, source: 'fuzzy' });
  });

  test('another vintage is refused', () => {
    const vintages = [
      c({ id: 10, brewery: 'PINTA Barrel Brewing', name: 'Affection (2025)', abv: 7.1 }),
      c({ id: 9, brewery: 'PINTA Barrel Brewing', name: 'Affection (2024)', abv: 6.8 }),
    ];
    // Before #636: { id: 10, source: 'fuzzy' }.
    expect(matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2023 Mango' }, vintages)).toBeNull();
  });

  test('an undated row is still an acceptable fuzzy hit for a dated input', () => {
    const undated = [c({ id: 8, brewery: 'PINTA Barrel Brewing', name: 'Affection', abv: 7.0 })];
    expect(matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2023 Mango' }, undated))
      .toMatchObject({ id: 8, source: 'fuzzy' });
  });

  test('a Czech grade that disagrees with the only row is refused', () => {
    const konrad = [c({ id: 45, brewery: 'Pivovar Konrad', name: 'Konrad Svetlé Výčepní 10', abv: 4.2 })];
    // Before #636: { id: 45, source: 'fuzzy' } for both spellings.
    expect(matchBeer({ brewery: 'Konrad Brewery', name: 'KONRAD 12°' }, konrad)).toBeNull();
    expect(matchBeer({ brewery: 'Konrad Brewery', name: 'Konrad 12' }, konrad)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — the refusals must fail, the controls must pass**

Run: `npx vitest run src/domain/matcher.test.ts -t "#636 fuzzy stage"`
Expected: 3 FAIL (`another number of the series is refused`, `another vintage is refused`, `a Czech grade that disagrees …`) each receiving the object noted in its `Before #636` comment; 2 PASS (the controls). If a refusal already passes, the input no longer reaches the fuzzy stage — stop and report.

- [ ] **Step 3: Implement**

In `src/domain/matcher.ts`, add the import directly under `import { aliasNeighbors, aliasKeys } from './brewery-aliases';`:

```ts
import { digitIdentity, readNameDigits } from './digit-identity';
```

and directly under `  if (nameTokensDiverge(nn, best.item.nameNorm)) return null;` add:

```ts
  // #636: the fuzzy key has no digits either — the same series row of another number scores 1.0.
  if (digitIdentity(readNameDigits(input.name), readNameDigits(best.item.name)) === 'different') return null;
```

It must sit **before** `if (usedFullFallback && budget) budget.hits++;` — `hits` counts non-null matches.

- [ ] **Step 4: Run — must pass**

Run: `npx vitest run src/domain/matcher.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Mutation proof** — delete the added gate line: the 3 refusal tests go red; restore it.

- [ ] **Step 6: Full gate** — `npm test && npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "fix(#636): the fuzzy stage refuses a best hit of another number or vintage

The fuzzy key is digit-free, so Przetwór #4 fuzzes onto Przetwór #3 and KONRAD 12°
onto Svetlé Výčepní 10. Without this gate the exact-stage fix would only move the
wrong link one stage down (probe: 10 of 14 live wrong links).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: exact stage — rows with different digits are not this beer

**Files:**
- Modify: `src/domain/matcher.ts` — the whole `if (exacts.length) { … }` block of `matchPrepared` (it starts with `const wantAbv = input.abv ?? null;` / `const inputYear = extractYear(input.name);` and ends with `// Only wrong-year candidates exist — do not cross-match vintages.` / `return null;` / `}`)
- Test: `src/domain/matcher.test.ts` — append the #636 exact describe; change one existing test

**Interfaces:**
- Consumes: `readNameDigits`, `digitIdentity` (Task 1), the import added in Task 2, the fuzzy gate (Task 2 — test `its number absent` relies on it).
- Produces: `matchPrepared` exact stage as in spec «Застосування → Ядро 1». Signature unchanged. `extractYear` stays exported but is no longer called inside `matcher.ts`.

- [ ] **Step 1: Write the failing tests** — append to `src/domain/matcher.test.ts`:

```ts
describe('#636 exact stage: rows with different digits are not this beer', () => {
  const przetwornia = (id: number, name: string) => c({ id, brewery: 'Przetwórnia Chmielu', name });

  test('its own number wins even when another number has the newer id', () => {
    // Before #636: 233 — the newest id among rows sharing the digit-free key.
    expect(matchBeer(
      { brewery: 'Przetwórnia Chmielu Brewery', name: 'Przetwór #4 16°' },
      [przetwornia(233, 'Przetwór #3'), przetwornia(200, 'Przetwór #4')],
    )).toEqual({ id: 200, confidence: 1, source: 'exact' });
  });

  test('its number absent: no link, and the fuzzy stage does not re-link the same row', () => {
    // Before #636: { id: 233, source: 'exact' }.
    expect(matchBeer(
      { brewery: 'Przetwórnia Chmielu Brewery', name: 'Przetwór #4 16°' },
      [przetwornia(233, 'Przetwór #3')],
    )).toBeNull();
  });

  test('control: the same number is still an exact match', () => {
    expect(matchBeer({ brewery: 'Przetwórnia Chmielu Brewery', name: 'Przetwór #3' }, [przetwornia(233, 'Przetwór #3')]))
      .toEqual({ id: 233, confidence: 1, source: 'exact' });
  });

  test('a mis-split title obeys the same gate', () => {
    // Before #636: { id: 233, source: 'exact' }.
    expect(matchBeer({ brewery: 'Przetwórnia', name: 'Chmielu Przetwór #4' }, [przetwornia(233, 'Przetwór #3')]))
      .toBeNull();
    expect(matchBeer({ brewery: 'Przetwórnia', name: 'Chmielu Przetwór #3' }, [przetwornia(233, 'Przetwór #3')]))
      .toEqual({ id: 233, confidence: 1, source: 'exact' });
  });

  test('no year in the input still takes the newest vintage over an older undated row', () => {
    expect(matchBeer({ brewery: 'Harpagan', name: 'Buzdygan Rozkoszy' }, [
      c({ id: 5, brewery: 'Harpagan', name: 'Buzdygan Rozkoszy', abv: 8.0 }),
      c({ id: 12, brewery: 'Harpagan', name: 'Buzdygan Rozkoszy 2026', abv: 9.5 }),
    ])).toEqual({ id: 12, confidence: 1, source: 'exact' });
  });
});
```

and change the existing test in `describe('matchBeer — vintage year disambiguation')` titled `year match + ABV mismatch + no noYear → wrongYear ABV hit wins (most recent)` to:

```ts
  test('year match + ABV mismatch + no noYear → same-year row kept, another vintage never taken (#636)', () => {
    // Was: the 2024 row with a fitting ABV won. A listing ABV typo is cheaper than another vintage's
    // rating and drunk state (spec 2026-09-16-636, «Свідома зміна поведінки»).
    const catalog = [
      pinta(10, 'Affection (2025)', 9.9),
      pinta(9,  'Affection (2024)', 7.0),
      pinta(7,  'Affection (2022)', 7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(10);
  });
```

- [ ] **Step 2: Run — must fail**

Run: `npx vitest run src/domain/matcher.test.ts`
Expected FAIL, exactly these 4: `its own number wins …` (got 233), `its number absent …` (got 233 exact), `a mis-split title obeys the same gate` (got 233), and the changed vintage test (got 9). Everything else passes, including `no year in the input still takes the newest vintage` and the controls.

- [ ] **Step 3: Implement** — replace the whole `if (exacts.length) { … }` block with:

```ts
  if (exacts.length) {
    // #636: the normalized key carries no digits, so an exact hit may be another number or vintage of
    // the same series (`Juicy Trap #19` / `#20`). A row whose digits are `different` is never this beer.
    // exacts is id DESC, so each group below keeps "most recent first".
    const wantAbv = input.abv ?? null;
    const abvFits = (c: PreparedBeer) =>
      wantAbv !== null && c.abv !== null && Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE;
    const inputDigits = readNameDigits(input.name);
    const same: PreparedBeer[] = [];
    const yearFallback: PreparedBeer[] = [];
    for (const c of exacts) {
      const identity = digitIdentity(inputDigits, readNameDigits(c.name));
      if (identity === 'same') same.push(c);
      else if (identity === 'year-fallback') yearFallback.push(c);
    }

    if (inputDigits.years.length === 0) {
      // No year in the input: ABV first, else the most recent row of any vintage.
      const pool = [...same, ...yearFallback].sort((a, b) => b.id - a.id);
      if (pool.length) {
        const hit = pool.find(abvFits) ?? pool[0];
        return { id: hit.id, confidence: 1, source: 'exact' };
      }
    } else if (same.length) {
      // Same-year row. If its ABV contradicts the input, a no-year row with a fitting ABV wins (a listing
      // ABV typo against an undated vintage); a row of another year never does.
      const candidate = same[0];
      const abvContradicts = wantAbv !== null && candidate.abv !== null && !abvFits(candidate);
      const hit = (abvContradicts ? yearFallback.find(abvFits) : undefined) ?? candidate;
      return { id: hit.id, confidence: 1, source: 'exact' };
    } else if (yearFallback.length) {
      // No same-year row: an undated row, ABV first.
      const hit = yearFallback.find(abvFits) ?? yearFallback[0];
      return { id: hit.id, confidence: 1, source: 'exact' };
    }
    // Every exact hit carries different digits: the series is here but this number is not. No fall-through
    // to fuzzy — its best hit is one of these same rows at score 1.0 and the digit gate would refuse it
    // anyway, while a mis-split input would spend the full-catalog fallback budget for nothing.
    return null;
  }
```

Every path of the block still returns: when every exact hit is `different` it returns `null` without entering the fuzzy stage (spec «Застосування → Ядро 1» explains why the fall-through was measured unobservable).

- [ ] **Step 4: Run — must pass**

Run: `npx vitest run src/domain/matcher.test.ts`
Expected: PASS, whole file — in particular every other test in `vintage handling`, `matchBeer — vintage year disambiguation`, `decimal release identifiers` and `anchored hit still respects ABV disambiguation across vintages`, unchanged.

- [ ] **Step 5: Mutation proof — each must turn the named test red, then revert**

| mutation | test that must fail |
|---|---|
| treat `'different'` like `'same'` (push into `same`) | `its own number wins …` |
| in the no-year branch, use `same` only instead of `[...same, ...yearFallback]` | `no year in the input still takes the newest vintage …` and `vintage handling › picks the latest vintage …` |
| in the `same` branch, drop `abvContradicts ? yearFallback.find(abvFits) : undefined` | `year match + ABV mismatch → noYear ABV hit wins` |
| replace the final `return null;` with nothing (fall through) | none — the fuzzy gate refuses the same rows; state it in the report. Instead prove the gate carries it: with the fall-through mutation AND the Task 2 gate line deleted, `its number absent …` goes red |

- [ ] **Step 6: Full gate** — `npm test && npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "fix(#636): the exact stage drops rows of another number or vintage before picking

The exact key is digit-free, so Juicy Trap #19 took #20 as the newest id. Rows with
different digits are filtered; a dated input prefers its year, then an undated row;
an undated input keeps today's newest-vintage pick. Deliberate change: a same-year
row with a contradicting ABV no longer yields to another year's row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: end-to-end review of the core (dispatched)

**Files:** none changed unless the review finds defects.

- [ ] **Step 1: Replay the next ingest, main vs worktree, back to back** (read-only; the catalog drifts, so both runs must be minutes apart):

```bash
( cd /home/ysi/warsaw-beer-bot && REPO=$PWD npx tsx ~/warsaw-beer-probes/636/replay-ingest-links.ts ) > /tmp/636-main.txt
REPO=$PWD npx tsx ~/warsaw-beer-probes/636/replay-ingest-links.ts > /tmp/636-core.txt
diff /tmp/636-main.txt /tmp/636-core.txt
```

The main checkout must be on a commit **without** #636 code (check `git -C /home/ysi/warsaw-beer-bot log -1`). Expected: the lines only in `636-core.txt` are the spec's «Вимір правила» set-3 links still on tap (`Juicy Trap #19`, `Dr.Hazy #4/#7`, `Przetwór #4`, `SPECIMEN 002`, `KONRAD 12°`, `Konrad 12`, `11 Horky`, …) turning into `ORPHAN` or their own number; no line may show a tap moving **onto** a row with different digits. Paste the diff into the review brief.

- [ ] **Step 2: Dispatch the reviewer** with: the spec path, this plan path, `git diff origin/main...HEAD -- src/`, the replay diff, and this explicit statement: *Tasks 1, 2 and 3 were executed inline by the controller without a per-task reviewer; review all three.* Ask specifically for:
  1. a name the rule mis-reads that the tests do not cover (the table is measured, not exhaustive);
  2. whether a caller of `matchPrepared` (`match-list.ts`, `refresh-ontap.ts`, `cleanup-polluted-ontap.ts`) now gets `null` for an input it matched before **and** the new `null` is wrong — the replay diff is the evidence;
  3. any test that passes vacuously (show the mutation).

- [ ] **Step 3: Resolve findings** — verify each against the code; fix real ones with the full gate and a commit naming the mechanism; push back on wrong ones in the report.

- [ ] **Step 4: Stop.** Report to the user: replay diff summary, review outcome, what the periphery plan must now assume. The periphery plan (`ensureBeerRow`, `ensureOrphan`/`resolvableOrphan`, `lookupBeer`, `spec.md`) is written only after this.
