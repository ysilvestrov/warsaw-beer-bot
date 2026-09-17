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
const HASH_MARKER_BEFORE = /(?:#|\b(?:no|nr)\.?)\s*$/i;
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
    // A '#', 'no.' or 'nr.' right before a year-shaped value makes it a number (`Beer #2024`), not a vintage.
    if (YEAR.test(value) && !HASH_MARKER_BEFORE.test(s.slice(0, m.index))) years.add(value);
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

/**
 * Two texts of the same kind — a tap name against an existing orphan's tap name (`ensureOrphan`, #617). Neither is
 * Untappd's, so there are no roles: they are one orphan only if neither direction is `different`. A
 * `number-fallback` one way is always `different` the other way (its candidate-only number is the reverse
 * direction's uncovered input number), so no separate check is needed.
 */
export function digitsCompatibleAsPeers(a: string, b: string): boolean {
  const digitsA = readNameDigits(a);
  const digitsB = readNameDigits(b);
  return digitIdentity(digitsA, digitsB) !== 'different' && digitIdentity(digitsB, digitsA) !== 'different';
}
