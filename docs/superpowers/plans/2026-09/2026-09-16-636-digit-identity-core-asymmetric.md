# #636 Digit Identity — Core, Asymmetric Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the committed symmetric digit rule into the agreed asymmetric one — a hard number only the candidate carries is a `number-fallback` tier — and make the matcher's exact stage use that tier last.

**Architecture:** `digitIdentity(input, candidate)` gains roles and a fourth verdict. The matcher already filters exact hits by verdict and gates fuzzy hits on `different`; it only needs a third group. No other file changes.

**Tech Stack:** TypeScript (CommonJS, Node 24), Vitest (globals).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-16-636-digit-identity-design.md` — «Правило (`digitIdentity(input, candidate)`)», «Асиметрія ролей», «Застосування → Ядро 1–2», «Вимір правила» rows «Асиметрично». Builds on the core plan `2026-09-16-636-digit-identity-core.md` (Tasks 1–4 complete, commits c29dd1b..f838f8b). The code below was run against a copy of the worktree; **the repo beats this plan** when they disagree — stop and report.

## Global Constraints

- Still core only: no PR, no deploy (spec «Порядок деплою»). Periphery plan comes after this plan's review.
- `DigitIdentity = 'same' | 'year-fallback' | 'number-fallback' | 'different'`, order `same > year-fallback > number-fallback`.
- `digitIdentity(input, candidate)`: `input` = tap/card text, `candidate` = catalog row / Untappd hit. Never call it with swapped roles in the matcher.
- Matcher: undated input merges `same` + `year-fallback` (unchanged); `number-fallback` is used only when both are empty; result stays `source: 'exact'`.
- Full gate after every task: `npm test && npm run typecheck`. Vitest on explicit paths only.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and name the mechanism.

Task sizing (CLAUDE.md): A1 and A2 carry complete code, one source file + test each, no new decision → inline by the controller; A3 is the dispatched review and names both.

---

### Task A1: `digitIdentity(input, candidate)` — roles and the `number-fallback` tier

**Files:**
- Modify: `src/domain/digit-identity.ts` (the `DigitIdentity` type and `digitIdentity`; `readNameDigits`, `minus`, `softContradictsGrade` unchanged)
- Modify: `src/domain/digit-identity.test.ts` (the `digitIdentity` table becomes directional)

**Interfaces:**
- Produces: `export type DigitIdentity = 'same' | 'year-fallback' | 'number-fallback' | 'different'`; `export function digitIdentity(input: NameDigits, candidate: NameDigits): DigitIdentity`.
- Consumers today: `src/domain/matcher.ts` (exact stage, fuzzy gate) — both already pass (input, candidate) in that order.

- [ ] **Step 1: Replace the test file** with:

```ts
import { digitIdentity, readNameDigits, type DigitIdentity } from './digit-identity';

// #636. Every pair below is a real catalog or tap name from the prod probe (spec 2026-09-16), so a rule change
// that "looks harmless" has to explain which measured beer it moves.
const identity = (input: string, candidate: string): DigitIdentity =>
  digitIdentity(readNameDigits(input), readNameDigits(candidate));

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

describe('digitIdentity(input, candidate)', () => {
  // [input, candidate, input→candidate, candidate→input]. A hard number only the candidate carries is a fallback;
  // only the input carrying it names another beer — so the two directions differ exactly there.
  test.each<[string, string, DigitIdentity, DigitIdentity]>([
    // ABV in the apostrophe spelling, or labelled without %, is not a number
    ["Gose 4'8%", 'Gose', 'same', 'same'],
    ['Stout 5.3 abv', 'Stout', 'same', 'same'],
    // a volume glued to its unit is not a number
    ['Lager 0,5l', 'Lager', 'same', 'same'],
    ['Hazy 1.5L', 'Hazy', 'same', 'same'],
    // grades are soft: never split on their own …
    ['Pils 12°', 'Pils', 'same', 'same'],
    ['Białe IPA 16°', 'Białe IPA 14°', 'same', 'same'],
    // … a soft number equal to the grade is the same beer …
    ['Otakar 11°', 'Otakar 11', 'same', 'same'],
    // … a grade covers a hard number on the other side (17 is outside the soft range) …
    ['Brutus 17°', 'Brutus 17', 'same', 'same'],
    ['Kamenice 10', 'Kamenice 10 12°', 'same', 'same'],
    // … whatever the grade spelling: `*`, a mid-dot ABV tail, a decimal comma
    ['Pils 12*', 'Pils 11°', 'same', 'same'],
    ['Pils 12,5°·4', 'Pils', 'same', 'same'],
    ['Kolaż 15,5°', 'Kolaż 15.5', 'same', 'same'],
    // … and a soft number that disagrees with the only grade is a different beer
    ['KONRAD 12°', 'Konrad Svetlé Výčepní 10', 'different', 'different'],
    // two-digit years
    ["Hoppiness'26", 'Hoppiness 2026', 'same', 'same'],
    ["Open Craft '26", 'Open Craft 2026 18°', 'same', 'same'],
    // years: equal sets, else different; one side only is a fallback
    ['Backwoods Bastard (2018)', 'Backwoods Bastard (2019)', 'different', 'different'],
    ['Backwoods Bastard', 'Backwoods Bastard (2018)', 'year-fallback', 'year-fallback'],
    ['Autonomia (2021/2022)', 'Autonomia (2022/2023)', 'different', 'different'],
    ['Affection (2025)', 'Affection 2025', 'same', 'same'],
    ['Echo 2026 10th Edition', 'ECHO the 10th Edition', 'year-fallback', 'year-fallback'],
    // markers make a number hard even inside the soft range: #, v, leading zero
    ['Dr.Hazy #12', 'Dr. Hazy', 'different', 'number-fallback'],
    ['SPECIMEN 010', 'Specimen', 'different', 'number-fallback'],
    ['Porter v10', 'Porter', 'different', 'number-fallback'],
    // a marked number is still covered by the same soft number on the other side
    ['Juicy Trap #12', 'Juicy Trap 12', 'same', 'same'],
    // ordinals are numbers
    ['Echo 16th Anniversary', 'Echo Anniversary', 'different', 'number-fallback'],
    // markers and leading zeros
    ['Uwarzone z Wami #3', 'Uwarzone Z Wami vol.3: Polish Black IPA', 'same', 'same'],
    ['Barrel Aged Serie No.38', 'Barrel Aged Serie No.35', 'different', 'different'],
    ['SPECIMEN 002', 'Specimen 2', 'same', 'same'],
    ['SPECIMEN 002', 'Specimen 001', 'different', 'different'],
    // versions split only when both sides carry one
    ['SPOKO CYDR 2.0 (Zweigelt Edition)', 'Spoko Cydr Zweigelt Edition', 'same', 'same'],
    ['Ambrosia 9.0', 'Ambrosia 5.0', 'different', 'different'],
    // soft 8–14 without a marker
    ['Svijanský Máz 11', 'Svijanský Máz', 'same', 'same'],
    ['Trappistes Rochefort 8', 'Trappistes Rochefort 10', 'different', 'different'],
    ['Trappistes Rochefort 6', 'Trappistes Rochefort 10', 'different', 'different'],
    // hard numbers on one side only: the input's is decisive, the candidate's is a fallback
    ['Paranormal Activity 2', 'Paranormal Activity', 'different', 'number-fallback'],
    ['Kronenbourg 1664', 'Kronenbourg', 'different', 'number-fallback'],
    ['Funky Monkey #2 12°', 'Funky Monkey', 'different', 'number-fallback'],
    ['Juicy Trap #19 18°', 'Juicy Trap #20', 'different', 'different'],
    // glued digits are not read (documented limit)
    ['BA23.03', 'BA23.02', 'same', 'same'],
    // documented cost: the grade does not cover the soft 10 of "10,5/10"
    ['Polska Desitka 10,5°', 'Polska Desitka 10,5/10', 'different', 'different'],
    // Untappd appends numbers shops leave out (measured on search-linked rows and the Few More Beer tap)
    ['Cucumber Gose', '10th Anniversary #6: Cucumber Gose', 'number-fallback', 'different'],
    ['Few More Beers 19°', 'Few More Beer 004/108', 'number-fallback', 'different'],
    // a candidate-only number outranks a one-sided year: it is the weaker fallback
    ['Life After Death Star', 'Life After Death Star (Batch 7) 2025', 'number-fallback', 'different'],
    // … unless the input carries its own number the candidate lacks: a soft number or a version
    ['Trappistes Rochefort 10', 'Trappistes Rochefort 6', 'different', 'different'],
    ['Potion #2.0', 'Potion #18', 'different', 'different'],
    // … and never overrides a year conflict
    ['Abraxas 2024', 'Abraxas (Batch 7) 2025', 'different', 'different'],
  ])('%s  →  %s  :  %s / reverse %s', (input, candidate, forward, reverse) => {
    expect(identity(input, candidate)).toBe(forward);
    expect(identity(candidate, input)).toBe(reverse);
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `npx vitest run src/domain/digit-identity.test.ts`
Expected: FAIL on every row whose reverse is `'number-fallback'` and on `Cucumber Gose`, `Few More Beers 19°`, `Life After Death Star` (the symmetric code returns `'different'`); `Trappistes Rochefort 10 → 6`, `Potion #2.0 → #18`, `Abraxas 2024` pass already. Record the count.

- [ ] **Step 3: Replace `src/domain/digit-identity.ts`** with:

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

// `same` > `year-fallback` > `number-fallback` > `different`. The two fallbacks are "acceptable when nothing better
// exists": a year only one side carries, or a hard number only the CANDIDATE carries.
export type DigitIdentity = 'same' | 'year-fallback' | 'number-fallback' | 'different';

// ABV in any spelling, incl. the apostrophe decimal ontap uses (`4'8%`). Removed first, so its digits are
// never read as numbers.
const ABV = /[<>]?\s*\d+(?:[.,'’]\d+)?\s*%/g;
const ABV_LABELLED = /\b\d+(?:[.,]\d+)?\s*abv\b/gi;
// A degree grade with an optional mid-dot ABV tail: `24°`, `12,5°·4`, `KONRAD 12*`.
const GRADE = /(\d+(?:[.,]\d+)?)\s*[°*](?:\s*[·•∙]\s*[<>]?\s*\d+(?:[.,'’]\d+)?\s*%?)?/gu;
const YEAR_APOSTROPHE_BEFORE = /(^|[\s(\[:\-]|\p{L})['’](\d{2})(?![\p{L}\p{N}])/gu;
const YEAR_APOSTROPHE_AFTER = /(?<![\p{L}\p{N}])(\d{2})['’](?=[\s):,\]\-]|$)/gu;
// A digit run not glued to a letter or digit (`WFP10`, `TAP04` are brand/batch codes, not numbers). A dot
// or comma before it is fine unless a digit precedes that (`vol.01` reads, `10.5` stays one token). A
// decimal is taken whole or not at all: without `(?![.,]\p{N})` the engine backtracks inside a volume glued
// to its unit (`0,5l`) and reads the `0`.
const NUMBER = /(?<![\p{L}\p{N}])(?<!\p{N}[.,])(v?)(\d+(?:[.,]\d+)?)(?![.,]\p{N})(?:st|nd|rd|th)?(?![\p{L}\p{N}])/giu;
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

/**
 * `input` is the text being matched (a tap, a shop card); `candidate` is a row that might be it (a catalog row, an
 * Untappd search hit). The roles are not symmetric: Untappd appends numbers shops leave out — batch, anniversary,
 * collab variant (`Cucumber Gose` → `10th Anniversary #6: Cucumber Gose`, `Few More Beers` → `Few More Beer
 * 004/108`) — so a number only the candidate carries is a fallback, while a number only the input carries says the
 * input names another beer (`Funky Monkey #2` is not `Funky Monkey`). Measured on 815 search-linked rows and the live
 * tap links (spec 2026-09-16-636, «Асиметрія ролей»).
 */
export function digitIdentity(input: NameDigits, candidate: NameDigits): DigitIdentity {
  // 1. Every hard number of the input must pair off with the candidate's numbers, or be covered by its grade or
  //    soft number.
  if (minus(minus(input.numbers, candidate.numbers), [...candidate.grades, ...candidate.soft]).length > 0) {
    return 'different';
  }
  const candidateOnly = minus(minus(candidate.numbers, input.numbers), [...input.grades, ...input.soft]);
  // A candidate-only number is a fallback only while the input carries no number of its own that the candidate
  // lacks — a soft number (`Trappistes Rochefort 10` is not `Trappistes Rochefort 6`) or a version (`Potion #2.0`
  // is not `Potion #18`). Grades are extract, not a number.
  const inputOwnUnmatched = [
    ...minus(input.soft, [...candidate.numbers, ...candidate.soft, ...candidate.grades]),
    ...minus(input.versions, candidate.versions),
  ];
  if (candidateOnly.length > 0 && inputOwnUnmatched.length > 0) return 'different';
  // 2. Grades and soft numbers never split on their own — except where they are the only number carrier.
  if (input.soft.length > 0 && candidate.soft.length > 0 && input.soft.join(' ') !== candidate.soft.join(' ')) {
    return 'different';
  }
  if (softContradictsGrade(input, candidate) || softContradictsGrade(candidate, input)) return 'different';
  // 3. Versions split only when both sides carry one.
  if (
    input.versions.length > 0 &&
    candidate.versions.length > 0 &&
    input.versions.join(' ') !== candidate.versions.join(' ')
  ) {
    return 'different';
  }
  // 4. Years on both sides must be equal sets.
  const inputYears = input.years.join(' ');
  const candidateYears = candidate.years.join(' ');
  if (inputYears !== '' && candidateYears !== '' && inputYears !== candidateYears) return 'different';
  // A number only the candidate carries is the weaker fallback, whatever the years say.
  if (candidateOnly.length > 0) return 'number-fallback';
  if ((inputYears === '') !== (candidateYears === '')) return 'year-fallback';
  return 'same';
}
```

- [ ] **Step 4: Run — must pass**

Run: `npx vitest run src/domain/digit-identity.test.ts`
Expected: PASS, 53 tests.

- [ ] **Step 5: Mutation proof** — each must turn the named row red, then revert:

| mutation in `digitIdentity` | row that must fail |
|---|---|
| delete the `inputOwnUnmatched` guard line (`if (candidateOnly.length > 0 && inputOwnUnmatched.length > 0) return 'different';`) | `Trappistes Rochefort 10 → Trappistes Rochefort 6` |
| drop `...minus(input.versions, candidate.versions),` from `inputOwnUnmatched` | `Potion #2.0 → Potion #18` |
| `return 'number-fallback'` → `return 'year-fallback'` | `Cucumber Gose → 10th Anniversary #6: Cucumber Gose` |
| move `if (candidateOnly.length > 0) return 'number-fallback';` above the years check | `Abraxas 2024 → Abraxas (Batch 7) 2025` |
| swap the two final checks (year-fallback before number-fallback) | `Life After Death Star → … (Batch 7) 2025` |
| in `candidateOnly`, drop `...input.grades` from the cover list | `Brutus 17° → Brutus 17` |

Also re-run the core review mutations (they must still all be red): `python3 .superpowers/sdd/2026-09-16-636-digit-identity-core/mutate-review.py` — the `soft does not cover` / `grades do not cover` mutations now edit `[...candidate.grades, ...candidate.soft]`; if a label reports `mutation did not apply`, update that script's search string to the new variable names first and say so.

- [ ] **Step 6: Prod verification (read-only)**

Run: `SYM=<a checkout at f838f8b> ASYM=$PWD npx tsx ~/warsaw-beer-probes/636/verify-asym.ts` — the controller may use the scratch copy of the symmetric module; one Algolia `getObjects` request.
Expected tallies (moved lists as in spec «Вимір правила»):
```
set 3 exact auto tap links (1494) same 1436, year-fallback 31, number-fallback 7, different 20   moved 7
set 4 fuzzy auto tap links (152)  same 143, year-fallback 7, number-fallback 1, different 1      moved 1
set 2 known-same (55)             same 52, number-fallback 2, different 1                        moved 2
set 1 known-different directed (3316) year-fallback 490, same 294, different 2485, number-fallback 47
search-linked rows (815)          same 774, year-fallback 20, number-fallback 8, different 13     moved 8
```

- [ ] **Step 7: Full gate** — `npm test && npm run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add src/domain/digit-identity.ts src/domain/digit-identity.test.ts
git commit -m "fix(#636): digit identity has roles — a number only the candidate carries is a fallback, not a different beer

Untappd appends batch, anniversary and collab-variant numbers shops leave out (815
search-linked rows: 6 correct finds the symmetric rule refused; Few More Beer 004/108).
A number only the input carries still names another beer, and so does a candidate-only
number when the input carries its own soft number or version (Rochefort 10 is not 6).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A2: matcher exact stage — `number-fallback` is the last tier

**Files:**
- Modify: `src/domain/matcher.ts` — the `if (exacts.length) { … }` block of `matchPrepared`
- Test: `src/domain/matcher.test.ts` — append one describe

**Interfaces:**
- Consumes: `digitIdentity(input, candidate)` and `'number-fallback'` from A1.
- Produces: unchanged `matchPrepared` signature; exact stage order same → year-fallback → number-fallback.

- [ ] **Step 1: Append the failing tests** to `src/domain/matcher.test.ts`:

```ts
describe('#636 asymmetry: a number only the catalog row carries is the weakest acceptable tier', () => {
  test('a tap without a number takes the only numbered row of its name', () => {
    // Symmetric rule: null. Untappd names the series number the tap leaves out.
    expect(matchBeer(
      { brewery: 'Zakładowy Brewery', name: 'Owocowa Fantazja 24°' },
      [c({ id: 50, brewery: 'Zakładowy Brewery', name: 'Owocowa Fantazja #1' })],
    )).toEqual({ id: 50, confidence: 1, source: 'exact' });
  });

  test('an unnumbered row beats a newer numbered one', () => {
    expect(matchBeer({ brewery: 'Piwne Podziemie', name: 'Juicy Trap' }, [
      c({ id: 10, brewery: 'Piwne Podziemie', name: 'Juicy Trap' }),
      c({ id: 30, brewery: 'Piwne Podziemie', name: 'Juicy Trap #20' }),
    ])).toEqual({ id: 10, confidence: 1, source: 'exact' });
  });

  test('an undated row of the year tier beats a numbered row for an undated input', () => {
    expect(matchBeer({ brewery: 'Piwne Podziemie', name: 'Juicy Trap' }, [
      c({ id: 10, brewery: 'Piwne Podziemie', name: 'Juicy Trap (2024)' }),
      c({ id: 30, brewery: 'Piwne Podziemie', name: 'Juicy Trap #20' }),
    ])).toEqual({ id: 10, confidence: 1, source: 'exact' });
  });

  test('among numbered rows only, ABV picks before the newest id', () => {
    expect(matchBeer({ brewery: 'Piwne Podziemie', name: 'Juicy Trap', abv: 6.0 }, [
      c({ id: 30, brewery: 'Piwne Podziemie', name: 'Juicy Trap #20', abv: 7.5 }),
      c({ id: 20, brewery: 'Piwne Podziemie', name: 'Juicy Trap #19', abv: 6.0 }),
    ])).toEqual({ id: 20, confidence: 1, source: 'exact' });
  });

  test('a number only the tap carries still refuses the unnumbered row', () => {
    expect(matchBeer(
      { brewery: "Hop'n Monkey Brewery", name: 'Funky Monkey #2 12°' },
      [c({ id: 70, brewery: "Hop'n Monkey", name: 'Funky Monkey' })],
    )).toBeNull();
  });

  test('the fuzzy stage accepts a candidate-only number (Few More Beer, live fuzzy link 0.96)', () => {
    expect(matchBeer(
      { brewery: 'Tankbusters Brewery', name: 'Few More Beers 19°' },
      [c({ id: 35283, brewery: 'TankBusters.Co', name: 'Few More Beer 004/108', abv: 8.4 })],
    )).toMatchObject({ id: 35283 });
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `npx vitest run src/domain/matcher.test.ts -t "#636 asymmetry"`
Expected after A1 (module asymmetric, matcher not yet): FAIL `a tap without a number takes the only numbered row of its name` (null — the exact block drops `number-fallback`), `among numbered rows only, ABV picks before the newest id`; PASS the other four (the fuzzy test already passes because the fuzzy gate only refuses `different`). On the symmetric code before A1 the controller measured 3 failures (the two above plus the fuzzy test).

- [ ] **Step 3: Implement** — in the exact block, collect the third group:

```ts
    const same: PreparedBeer[] = [];
    const yearFallback: PreparedBeer[] = [];
    const numberFallback: PreparedBeer[] = [];
    for (const c of exacts) {
      const identity = digitIdentity(inputDigits, readNameDigits(c.name));
      if (identity === 'same') same.push(c);
      else if (identity === 'year-fallback') yearFallback.push(c);
      else if (identity === 'number-fallback') numberFallback.push(c);
    }
```

and directly after the `else if (yearFallback.length) { … }` branch, before the `// Every exact hit carries different digits` comment:

```ts
    if (numberFallback.length) {
      // Only rows with a number the input does not carry (Untappd's batch/anniversary/variant number the tap
      // leaves out): the weakest acceptable tier, ABV first, else the most recent.
      const hit = numberFallback.find(abvFits) ?? numberFallback[0];
      return { id: hit.id, confidence: 1, source: 'exact' };
    }
```

- [ ] **Step 4: Run — must pass**: `npx vitest run src/domain/digit-identity.test.ts src/domain/matcher.test.ts` → 232 passed.

- [ ] **Step 5: Mutation proof**

| mutation | test that must fail |
|---|---|
| push `number-fallback` rows into `yearFallback` (the undated input then merges them by newest id → 30) | `an unnumbered row beats a newer numbered one` and `an undated row of the year tier beats a numbered row …` |
| delete the `numberFallback` branch | `a tap without a number takes the only numbered row of its name` |
| `numberFallback.find(abvFits) ?? numberFallback[0]` → `numberFallback[0]` | `among numbered rows only, ABV picks before the newest id` |
| fuzzy gate `=== 'different'` → `!== 'same'` | `the fuzzy stage accepts a candidate-only number` |

- [ ] **Step 6: Full gate**, then **Commit**

```bash
git add src/domain/matcher.ts src/domain/matcher.test.ts
git commit -m "fix(#636): the exact stage takes a row with a number the tap leaves out only when no unnumbered row fits

Juicy Trap keeps the unnumbered row over a newer #20; with numbered rows only, ABV then the
newest id decide, as for vintages.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task A3: replay + review of the asymmetric delta (dispatched)

- [ ] **Step 1: Replay the next ingest**, main checkout then worktree, back to back, into the SDD workspace (`replay-main-asym.txt`, `replay-core-asym.txt`), and diff. Expected versus the symmetric replay: `Few More Beers 19°` no longer turns ORPHAN; no tap moves onto a row with a number the tap carries differently; `Kronenbourg 1664 Blanc 12,5°` still ORPHAN.
- [ ] **Step 2: Review package** `review-package <plan> f838f8b HEAD`; dispatch a reviewer (opus) naming A1 and A2 as inline tasks, with the spec, both plans, the replay diff, `verify-asym.out`, and questions: (1) a real name where the roles are swapped at a call site; (2) whether `number-fallback` in the exact stage can pick a numbered row while an unnumbered row exists under a different normalized key (fuzzy-only) — what the user sees; (3) vacuous tests (mutations).
- [ ] **Step 3:** resolve findings (fix + gate + commit per finding, scoped re-review), then **stop** and write the periphery plan.
