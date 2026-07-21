import { baseNormalize } from './normalize';

// Plato range for the bare-integer grade path. Below 7 / above 20 is not a Czech grade
// (excludes vintage years like 2026 and numeric beer names like "Pinta 555").
const GRADE_MIN = 7;
const GRADE_MAX = 20;

// Spelled-out Czech grade words → grade number. Keys are already diacritic-stripped and
// lowercased to match baseNormalize output. Grow this as new shop spellings appear.
export const CZECH_GRADE_WORDS: ReadonlyMap<string, number> = new Map([
  ['osmicka', 8],
  ['devitka', 9],
  ['desitka', 10],
  ['jedenactka', 11],
  ['dvanactka', 12],
  ['dvanastka', 12], // observed shop misspelling (beer_id 29429 "Dvanastka")
  ['trinactka', 13],
  ['ctrnactka', 14],
]);

// A Czech grade denotes a pale lager, never these. Matched against both the Untappd style
// label and the beer-name tokens.
const ALE_STYLE_WORDS: ReadonlySet<string> = new Set([
  'ipa', 'apa', 'neipa', 'dipa', 'tipa', 'aipa',
  'gose', 'stout', 'porter', 'sour', 'saison',
  'lambic', 'weizen', 'wheat', 'witbier', 'barleywine',
]);

// Dark-beer markers (Czech pale is the default). A plain grade must not grab a dark variant.
const DARK_WORDS: ReadonlySet<string> = new Set([
  'tmavy', 'tmava', 'tmave', 'cerny', 'cerne', 'dark',
]);

// Lager/colour tokens that are NOT distinctive descriptors when ranking candidates.
const LAGER_KEYWORDS: ReadonlySet<string> = new Set([
  'lezak', 'vycepni', 'svetly', 'svetle', 'svetla', 'lager', 'pilsner', 'pils',
]);

function tokens(s: string): string[] {
  return baseNormalize(s).split(' ').filter(Boolean);
}

function isGradeToken(token: string, grade: number): boolean {
  if (CZECH_GRADE_WORDS.get(token) === grade) return true;
  return /^\d+$/.test(token) && Number(token) === grade;
}

// Grade from a spelled Czech word or a bare integer in the Plato range. First hit wins;
// null when the name carries no grade signal.
export function extractGrade(name: string): number | null {
  for (const t of tokens(name)) {
    const word = CZECH_GRADE_WORDS.get(t);
    if (word != null) return word;
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n >= GRADE_MIN && n <= GRADE_MAX) return n;
    }
  }
  return null;
}

function matchesAny(beerName: string, style: string | null, words: ReadonlySet<string>): boolean {
  const toks = tokens(beerName);
  if (style) toks.push(...tokens(style));
  return toks.some((t) => words.has(t));
}

export function isAleStyle(beerName: string, style: string | null): boolean {
  return matchesAny(beerName, style, ALE_STYLE_WORDS);
}

export function isDark(beerName: string, style: string | null): boolean {
  return matchesAny(beerName, style, DARK_WORDS);
}

// Count of descriptor tokens in the beer name beyond brand, grade, and lager/colour keywords.
// Lower = more generic: a plain "Světlý ležák 11°" (0) beats a seasonal "Vánoční …" (1).
export function extraDescriptorCount(beerName: string, breweryNorm: string, grade: number): number {
  const brandToks = new Set(breweryNorm.split(' ').filter(Boolean));
  let count = 0;
  for (const t of tokens(beerName)) {
    if (brandToks.has(t)) continue;
    if (LAGER_KEYWORDS.has(t)) continue;
    if (isGradeToken(t, grade)) continue;
    count++;
  }
  return count;
}
