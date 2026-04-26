const STYLE_WORDS = new Set([
  'ipa', 'apa', 'neipa', 'dipa', 'tipa', 'aipa', 'neneipa',
  'imperial', 'double', 'triple', 'session', 'dry', 'hopped', 'dh', 'ddh',
  'pils', 'pilsner', 'lager', 'stout', 'porter', 'weizen', 'wheat',
  'saison', 'sour', 'gose', 'lambic', 'barleywine', 'bock',
]);
const BREWERY_NOISE = new Set(['browar', 'brewery', 'brewing', 'co', 'company']);

// NFD decomposes most Polish diacritics (ą ć ę ń ó ś ź ż and their
// uppercase forms) into a base letter + a combining mark from the
// U+0300–U+036F block, which the regex then strips. Ł/ł is the one
// Polish letter that is NOT canonically decomposable — it's a base
// letter with an inherent stroke (U+0141 / U+0142), so NFD leaves it
// intact and we replace it explicitly.
function stripDiacritics(s: string): string {
  return s.normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L');
}

function baseNormalize(s: string): string {
  return stripDiacritics(s).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip pure-digit tokens — covers ontap noise like "24" / "8" / "5"
// (left over after baseNormalize splits "24°·8,5%") and Untappd vintage
// suffixes like "2024"/"2026". Trade-off: legitimate numeric beer names
// ("Pinta 555") collapse too — acceptable for now.
const isNumericNoise = (t: string): boolean => /^\d+$/.test(t);

export function normalizeName(s: string): string {
  const tokens = baseNormalize(s)
    .split(' ')
    .filter((t) => t && !STYLE_WORDS.has(t) && !isNumericNoise(t));
  return tokens.join(' ');
}

export function normalizeBrewery(s: string): string {
  const tokens = baseNormalize(s)
    .split(' ')
    .filter((t) => t && !BREWERY_NOISE.has(t) && !isNumericNoise(t));
  return tokens.join(' ');
}
