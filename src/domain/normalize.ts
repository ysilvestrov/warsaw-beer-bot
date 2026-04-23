const STYLE_WORDS = new Set([
  'ipa', 'apa', 'neipa', 'dipa', 'tipa', 'aipa', 'neneipa',
  'imperial', 'double', 'triple', 'session', 'dry', 'hopped', 'dh', 'ddh',
  'pils', 'pilsner', 'lager', 'stout', 'porter', 'weizen', 'wheat',
  'saison', 'sour', 'gose', 'lambic', 'barleywine', 'bock',
]);
const BREWERY_NOISE = new Set(['browar', 'brewery', 'brewing', 'co', 'company']);

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

export function normalizeName(s: string): string {
  const tokens = baseNormalize(s).split(' ').filter((t) => t && !STYLE_WORDS.has(t));
  return tokens.join(' ');
}

export function normalizeBrewery(s: string): string {
  const tokens = baseNormalize(s).split(' ').filter((t) => t && !BREWERY_NOISE.has(t));
  return tokens.join(' ');
}
