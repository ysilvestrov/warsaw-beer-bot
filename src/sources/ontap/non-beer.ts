export interface OntapNonBeerInput {
  style: string | null;
  brewery_ref: string | null;
}

const STYLE_TOKENS = [
  'vino',
  'wino',
  'wina',
  'prosecco',
  'frizzante',
  'spritz',
  'aperitivo',
  'koktajl',
  'musujące',
  'wytrawne',
  'półwytrawne',
  'słodkie',
];

const EXACT_STYLE_PHRASES = new Set([
  'aperitivo',
  'aperitivo spritz',
  'aperol spritz',
  'białe wino musujące',
  'białe wino musujące wytrawne',
  'drink, czarny bez, mięta i limonka',
  'frizzante [wino musujące]',
  'mojito drink',
  'orange bitter',
  'primitivo',
  'własny koktajl z kija',
]);

const BREWERY_TOKENS = [
  'wino',
  'wine',
  'winiarska',
  'maccari',
  'frizzanti',
  'cantine',
  'san martino',
  'conegliano',
  'puglia',
  'vini',
  'dolium vini',
  'stacja winiarska',
];

const EXACT_BREWERY_SENTINELS = new Set([
  'aperitivo spritz',
  'hugo',
  'mojito',
]);

function norm(raw: string | null): string {
  return raw?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

export function isOntapNonBeerTap(tap: OntapNonBeerInput): boolean {
  const style = norm(tap.style);
  if (style && (EXACT_STYLE_PHRASES.has(style) || STYLE_TOKENS.some((token) => style.includes(token)))) {
    return true;
  }

  const brewery = norm(tap.brewery_ref);
  if (brewery && (EXACT_BREWERY_SENTINELS.has(brewery) || BREWERY_TOKENS.some((token) => brewery.includes(token)))) {
    return true;
  }

  return false;
}
