/**
 * #659 — a shop typo that relocates ONE letter inside one token (`UTH`↔`UHT`, `Tounge`↔`Tongue`).
 *
 * `fast-fuzzy` cannot carry these: its score is length-normalized (one swap in a 3-letter token is
 * 0.667, under NEAR_TOKEN_SIM) and substring-based (`slik` scores the same 0.75 against `Silk.` and
 * `Slice.`). Measured on 34 342 catalogue beers: pairs of DIFFERENT same-brewery beers one relocated
 * letter apart — 3, none with agreeing ABV; one arbitrary edit — 304, 163 with agreeing ABV. That
 * is why this is a relocation, never an edit distance.
 */
const MIN_TOKEN_LENGTH = 3;
const DIGIT = /\d/;
// A valid numeral, not "letters from ivxlcdm": that would also exclude `mild`, `lid`, `dim`.
const ROMAN_NUMERAL = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

function isNumbering(token: string): boolean {
  return DIGIT.test(token) || ROMAN_NUMERAL.test(token);
}

export function isMovedLetter(a: string, b: string): boolean {
  if (a === b || a.length !== b.length || a.length < MIN_TOKEN_LENGTH) return false;
  if (isNumbering(a) || isNumbering(b)) return false;
  for (let from = 0; from < a.length; from += 1) {
    const rest = a.slice(0, from) + a.slice(from + 1);
    for (let to = 0; to <= rest.length; to += 1) {
      if (rest.slice(0, to) + a[from] + rest.slice(to) === b) return true;
    }
  }
  return false;
}

export function isMovedLetterName(target: string, candidate: string): boolean {
  const targetTokens = target.split(' ').filter(Boolean);
  const candidateTokens = candidate.split(' ').filter(Boolean);
  if (targetTokens.length === 0 || targetTokens.length !== candidateTokens.length) return false;
  const differing = targetTokens.flatMap((token, index) => (token === candidateTokens[index] ? [] : [index]));
  return differing.length === 1 && isMovedLetter(targetTokens[differing[0]], candidateTokens[differing[0]]);
}
