// #636: which digits of a beer name say WHICH beer it is.
//
// `normalizeName` drops every digit token and `stripSearchNoise` drops brackets (with their years) and
// degree grades (with their number), so two different beers of one series share a normalized key:
// `Juicy Trap #19` / `#20`, `Trappistes Rochefort 6` / `10`, `Stary Sad 2023` / `2025`. Every place that
// reads that key as identity asks this module instead of re-deriving digits on its own.
//
// The rules below are measured, not guessed (spec 2026-09-16-636-digit-identity-design.md, prototype over
// 1 658 known-different pairs, 55 known-same pairs and 1 494 live tap links).

import { baseNormalize, stripLegalForm, canonicalizeBreweryBrand, BREWERY_NOISE, BREWERY_COLLAB_SEP } from './normalize';
import { isAleStyle } from './czech-grade';

export interface DigitIdentityContext {
  input: { name: string; style?: string | null; brewery?: string | null };
  candidate: { name: string; style?: string | null; brewery?: string | null };
  knownBreweries?: readonly string[];
}

export interface NameDigits {
  /** Hard numbers (`#7`, `vol.4`, `002` → `2`, `1664`): a leftover one on either side means a different beer. */
  numbers: string[];
  /** Unmarked integers 8–14 (`Svijanský Máz 11`): a Czech grade written without `°`; soft like a grade. */
  soft: string[];
  /** Degree grades (`12°`, `12,5°` → `12.5`): extract by default; explicit Czech lager context can split them. */
  grades: string[];
  /** Release versions `N.0` (`Ambrosia 9.0`): tell beers apart only when both sides carry one. */
  versions: string[];
  /** Calendar years, including `'26` / `26'` → `2026` and both ends of `2015-2022`. */
  years: string[];
  /** #663: Whether the name contains any letter characters outside of stripped ABV/grade/noise. */
  hasLetters: boolean;
  hops?: string[];
  tapCodes?: string[];
  hardCodes?: string[];
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

function readOrdinaryNameDigits(name: string): NameDigits {
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
    hasLetters: /\p{L}/u.test(s),
  };
}

type Span = { start: number; end: number };
type CodeSpan = Span & { kind: 'hop' | 'tap' | 'hard'; id: string };
type Side = 'input' | 'candidate';

const PREFIX_HOP = /(?<![\p{L}\p{N}])(HBC|BRU|NZH|YCR|PŁ|CF)[\s-]*(\d+)(?![\p{L}\p{N}])/giu;
const IDAHO_HOP = /(?<![\p{L}\p{N}])Idaho\s*7(?![\p{L}\p{N}])/giu;
const FRACTION_HOP = /(?<![\p{L}\p{N}])(?:EXP\s*)?(\d+)\s*\/\s*(\d+)(?![\p{L}\p{N}])/giu;
const POLISH_FRACTIONS = new Set(['2/20', '3/20', '5/39']);
const FRACTION_MARKER = /(?:#|\b(?:no|nr|batch|series|kegged|bottled|released|date)\.?)\s*$/i;
const TAP_CODE = /(?<![\p{L}\p{N}])TAP[\s-]*(\d+)(?![\p{L}\p{N}])/giu;
const LAB_CODE = /(?<![\p{L}\p{N}])LAB[\s-]*(\d+)(?![\p{L}\p{N}])/giu;
const EL_CODE = /(?<![\p{L}\p{N}])EL[\s-]*(\d+)(?![\p{L}\p{N}])/giu;
const HORSESHOE_CODE = /(?<![\p{L}\p{N}])53\s*M(?![\p{L}\p{N}])/giu;

function maskSpans(name: string, spans: readonly Span[]): string {
  const chars = name.split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end; i++) chars[i] = ' ';
  }
  return chars.join('');
}

function findNoiseSpans(name: string): Span[] {
  return [ABV, ABV_LABELLED, GRADE].flatMap((pattern) =>
    [...name.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length })),
  );
}

// Do not turn a prefix of a decimal, fraction, or date into an integer code.
function completeCode(name: string, span: Span): boolean {
  return !/[\d][.,/]\s*$/.test(name.slice(0, span.start))
    && !/^\s*[.,/]\s*\d/.test(name.slice(span.end));
}

function localRegion(name: string, span: Span): string {
  const separators = [...name.matchAll(/[()[\];,]|\s+-\s+/g)];
  const start = separators.filter((m) => m.index + m[0].length <= span.start).at(-1);
  const end = separators.find((m) => m.index >= span.end);
  return name.slice(start ? start.index + start[0].length : 0, end?.index ?? name.length);
}

function hasPolishHopsLabel(name: string): boolean {
  return /(?:^| )polish ?hops(?: |$)/.test(baseNormalize(name));
}

function brandTokens(raw: string): string[] {
  return baseNormalize(stripLegalForm(canonicalizeBreweryBrand(raw)))
    .split(' ').filter((token) => token && !BREWERY_NOISE.has(token));
}

function explicitBrands(context: DigitIdentityContext): string[][] {
  return [context.input.brewery, context.candidate.brewery].flatMap((label) =>
    (label ?? '').split(BREWERY_COLLAB_SEP).map(brandTokens),
  );
}

function hasBrand(context: DigitIdentityContext, prefix: readonly string[]): boolean {
  return explicitBrands(context).some((tokens) => prefix.every((token, i) => tokens[i] === token));
}

function findBrandNumberSpans(name: string, context?: DigitIdentityContext): Span[] {
  if (!context) return [];
  const brands = [
    ...explicitBrands(context),
    ...(context.knownBreweries ?? []).flatMap((label) => label.split(BREWERY_COLLAB_SEP).map(brandTokens)),
  ].filter((tokens) => tokens.some((token) => /^\d+$/.test(token))
    && tokens.some((token) => /\p{L}/u.test(token)));
  const tokens = [...name.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)]
    .map((match) => ({ token: baseNormalize(match[0]), start: match.index, end: match.index + match[0].length }))
    .filter(({ token }) => !BREWERY_NOISE.has(token));
  const noise = findNoiseSpans(name);
  const spans: Span[] = [];
  for (const brand of brands) {
    for (let i = 0; i <= tokens.length - brand.length; i++) {
      const run = tokens.slice(i, i + brand.length);
      if (!brand.every((token, j) => run[j].token === token)) continue;
      for (const token of run) {
        if (!/^\d+$/.test(token.token) || MARKER_BEFORE.test(name.slice(0, token.start))
          || !completeCode(name, token)
          || noise.some((span) => span.start < token.end && token.start < span.end)) continue;
        spans.push({ start: token.start, end: token.end });
      }
    }
  }
  if (hasBrand(context, ['sir', 'james'])) {
    const leading = /^\s*(101)(?=\s)/.exec(name);
    if (leading && /^(?:mojito|ginger mule|spritz|passionfruit martini|pink g t)(?: |$)/
      .test(baseNormalize(name.slice(leading[0].length)))) {
      spans.push({ start: leading[0].length - 3, end: leading[0].length });
    }
  }
  return spans;
}

function findHopSpans(name: string, context?: DigitIdentityContext, side?: Side): CodeSpan[] {
  const scan = maskSpans(name, findNoiseSpans(name));
  const spans: CodeSpan[] = [];
  for (const match of scan.matchAll(PREFIX_HOP)) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (completeCode(scan, span)) spans.push({ ...span, kind: 'hop', id: `${match[1].toUpperCase()}:${canon(match[2])}` });
  }
  for (const match of scan.matchAll(IDAHO_HOP)) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (completeCode(scan, span)) spans.push({ ...span, kind: 'hop', id: 'Idaho:7' });
  }
  const pending: CodeSpan[] = [];
  for (const match of scan.matchAll(FRACTION_HOP)) {
    const span = { start: match.index, end: match.index + match[0].length };
    const fraction = `${canon(match[1])}/${canon(match[2])}`;
    if (!POLISH_FRACTIONS.has(fraction) || !completeCode(scan, span)
      || FRACTION_MARKER.test(scan.slice(0, span.start))) continue;
    const code: CodeSpan = { ...span, kind: 'hop', id: `PolishHops:${fraction}` };
    if (/^EXP/i.test(match[0]) || hasPolishHopsLabel(localRegion(scan, span))
      || (context && side && hasPolishHopsLabel(context[side].brewery ?? ''))) spans.push(code);
    else pending.push(code);
  }
  // Only an explicit connector chain can transfer a code claim to an unlabelled fraction.
  let added = true;
  while (added) {
    added = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const code = pending[i];
      const connected = spans.some((seed) => {
        const gap = seed.end <= code.start ? scan.slice(seed.end, code.start)
          : code.end <= seed.start ? scan.slice(code.end, seed.start) : '';
        return /^\s*(?:x|&|\+)\s*$/i.test(gap);
      });
      if (connected) {
        spans.push(code);
        pending.splice(i, 1);
        added = true;
      }
    }
  }
  return spans;
}

function findSeriesCodeSpans(name: string, context?: DigitIdentityContext): CodeSpan[] {
  if (!context) return [];
  const scan = maskSpans(name, findNoiseSpans(name));
  const families: { brand: string[]; pattern: RegExp; kind: 'tap' | 'hard'; namespace: string }[] = [
    { brand: ['schneider', 'weisse'], pattern: TAP_CODE, kind: 'tap', namespace: 'TAP' },
    { brand: ['pracownia', 'piwa'], pattern: LAB_CODE, kind: 'hard', namespace: 'LAB' },
    { brand: ['moersleutel'], pattern: EL_CODE, kind: 'hard', namespace: 'EL' },
    { brand: ['hop', 'brook'], pattern: HORSESHOE_CODE, kind: 'hard', namespace: '53M' },
  ];
  const spans: CodeSpan[] = [];
  for (const family of families) {
    if (!hasBrand(context, family.brand)) continue;
    for (const match of scan.matchAll(family.pattern)) {
      const span = { start: match.index, end: match.index + match[0].length };
      if (!completeCode(scan, span)) continue;
      spans.push({ ...span, kind: family.kind,
        id: family.namespace === '53M' ? '53M' : `${family.namespace}:${canon(match[1])}` });
    }
  }
  return spans;
}

function readProfile(name: string, context?: DigitIdentityContext, side?: Side): NameDigits {
  const branded = maskSpans(name, findBrandNumberSpans(name, context));
  const spans = [...findHopSpans(branded, context, side), ...findSeriesCodeSpans(branded, context)];
  const ordinary = readOrdinaryNameDigits(maskSpans(branded, spans));
  ordinary.hasLetters = readOrdinaryNameDigits(name).hasLetters;
  const hops = [...new Set(spans.filter((span) => span.kind === 'hop').map((span) => span.id))].sort();
  const tapCodes = [...new Set(spans.filter((span) => span.kind === 'tap').map((span) => span.id))].sort();
  const hardCodes = spans.filter((span) => span.kind === 'hard').map((span) => span.id).sort();
  return { ...ordinary,
    ...(hops.length > 0 ? { hops } : {}),
    ...(tapCodes.length > 0 ? { tapCodes } : {}),
    ...(hardCodes.length > 0 ? { hardCodes } : {}),
  };
}

export function readNameDigits(name: string): NameDigits {
  return readProfile(name);
}

function differentNonEmptySets(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length > 0 && right.length > 0 && left.join('|') !== right.join('|');
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

function hasCzechLagerStyle(style: string | null | undefined): boolean {
  const words = new Set(baseNormalize(style ?? '').split(' ').filter(Boolean));
  const czech = words.has('czech') || words.has('bohemian');
  const lager = words.has('lager') || words.has('pils') || words.has('pilsner');
  const colour = ['svetly', 'svetle', 'tmavy', 'polotmave'].some((word) => words.has(word));
  return (czech && lager) || (words.has('lezak') && colour);
}

function singleIntegerGrade(grades: readonly string[]): number | null {
  const values = [...new Set(grades.map(Number))];
  if (values.length !== 1) return null;
  const value = values[0];
  return Number.isInteger(value) && value >= 7 && value <= 20 ? value : null;
}

export function explicitGradesContradict(input: NameDigits, candidate: NameDigits): boolean {
  const a = singleIntegerGrade(input.grades);
  const b = singleIntegerGrade(candidate.grades);
  return a !== null && b !== null && a !== b;
}

export function czechGradesContradict(
  input: NameDigits,
  candidate: NameDigits,
  context?: DigitIdentityContext,
): boolean {
  if (!context) return false;
  if (!explicitGradesContradict(input, candidate)) return false;
  if (!hasCzechLagerStyle(context.input.style) && !hasCzechLagerStyle(context.candidate.style)) return false;
  if (isAleStyle(context.input.name, context.input.style ?? null)
    || isAleStyle(context.candidate.name, context.candidate.style ?? null)) return false;
  return true;
}

/**
 * `input` is the text being matched (a tap, a shop card); `candidate` is a row that might be it (a catalog row, an
 * Untappd search hit). The roles are not symmetric: Untappd appends numbers shops leave out — batch, anniversary,
 * collab variant (`Cucumber Gose` → `10th Anniversary #6: Cucumber Gose`, `Few More Beers` → `Few More Beer
 * 004/108`) — so a number only the candidate carries is a fallback, while a number only the input carries says the
 * input names another beer (`Funky Monkey #2` is not `Funky Monkey`). Measured on 815 search-linked rows and the live
 * tap links (spec 2026-09-16-636, «Асиметрія ролей»).
 */
export function digitIdentity(
  input: NameDigits,
  candidate: NameDigits,
  context?: DigitIdentityContext,
): DigitIdentity {
  if (context) {
    input = readProfile(context.input.name, context, 'input');
    candidate = readProfile(context.candidate.name, context, 'candidate');
  }
  if (differentNonEmptySets(input.hops ?? [], candidate.hops ?? [])) return 'different';
  if (differentNonEmptySets(input.tapCodes ?? [], candidate.tapCodes ?? [])) return 'different';
  if (minus(input.hardCodes ?? [], candidate.hardCodes ?? []).length > 0) return 'different';
  const candidateCodeOnly = minus(candidate.hardCodes ?? [], input.hardCodes ?? []);
  if (czechGradesContradict(input, candidate, context)) return 'different';
  // 1. Every hard number of the input must pair off with the candidate's numbers, or be covered by its grade or
  //    soft number.
  if (minus(minus(input.numbers, candidate.numbers), [...candidate.grades, ...candidate.soft]).length > 0) {
    return 'different';
  }
  const candidateOnly = minus(minus(candidate.numbers, input.numbers), [...input.grades, ...input.soft]);
  const hasCandidateOnly = candidateOnly.length > 0 || candidateCodeOnly.length > 0;
  // A candidate-only number is a fallback only while the input carries no number of its own that the candidate
  // lacks — a soft number (`Trappistes Rochefort 10` is not `Trappistes Rochefort 6`) or a version (`Potion #2.0`
  // is not `Potion #18`). Grades are extract, not a number.
  const inputOwnUnmatched = [
    ...minus(input.soft, [...candidate.numbers, ...candidate.soft, ...candidate.grades]),
    ...minus(input.versions, candidate.versions),
  ];
  if (hasCandidateOnly && inputOwnUnmatched.length > 0) return 'different';
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
  // #663: Untappd appends numbers to names (batch, edition, variant), but a purely numeric candidate
  // (e.g. `21`, `15`) has no letters and cannot be an appended variant of an input.
  if (hasCandidateOnly) {
    if (!candidate.hasLetters) return 'different';
    return 'number-fallback';
  }
  if ((inputYears === '') !== (candidateYears === '')) return 'year-fallback';
  return 'same';
}

/**
 * Two texts of the same kind — a tap name against an existing orphan's tap name (`ensureOrphan`, #617). Neither is
 * Untappd's, so there are no roles: they are one orphan only if neither direction is `different`. A
 * `number-fallback` one way is always `different` the other way (its candidate-only number is the reverse
 * direction's uncovered input number), so no separate check is needed.
 */
export function digitsCompatibleAsPeers(a: string, b: string, context?: DigitIdentityContext): boolean {
  const digitsA = readNameDigits(a);
  const digitsB = readNameDigits(b);
  const reverse = context ? { ...context, input: context.candidate, candidate: context.input } : undefined;
  return digitIdentity(digitsA, digitsB, context) !== 'different'
    && digitIdentity(digitsB, digitsA, reverse) !== 'different';
}
