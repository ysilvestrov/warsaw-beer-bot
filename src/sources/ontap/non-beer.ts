export interface OntapNonBeerInput {
  style: string | null;
  brewery_ref: string | null;
  beer_ref?: string | null;
}

const EXACT_BEER_SENTINELS = new Set(['kran w serwisie']);

const STYLE_TOKENS = [
  'vino',
  'wino',
  'wina',
  'prosecco',
  'frizzante',
  'spritz',
  'aperitivo',
  'koktajl',
  'cocktail',
  'nalewka',
  'szprycer',
  'kombucha',
  'glera',
  'musujące',
  'wytrawne',
  'półwytrawne',
  'słodkie',
];

const ELIGIBLE_STYLE_TOKENS = [
  'cydr',
  'cider',
  'kwas chlebowy',
  'kvass',
  'квас',
  'mead',
  'melomel',
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
  'cantina',
  'aperitivo',
  'kombucha',
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

// Parser pollution: a brewery_ref that is actually a schedule / navigation
// breadcrumb (e.g. "Basement -> Czwartek-Sobota od 18.00 Brewery"), never a real
// brewery. Conservative signals: a "->" nav arrow, or an opening-hours time range
// like "od 18.00".
function looksLikeScheduleOrNav(brewery: string): boolean {
  return brewery.includes('->') || /\bod\s+\d{1,2}[.:]\d{2}\b/.test(brewery);
}

export function isOntapNonBeerTap(tap: OntapNonBeerInput): boolean {
  if (EXACT_BEER_SENTINELS.has(norm(tap.beer_ref ?? null))) {
    return true;
  }

  const style = norm(tap.style);
  if (style && ELIGIBLE_STYLE_TOKENS.some((token) => style.includes(token))) {
    return false;
  }
  if (style && (EXACT_STYLE_PHRASES.has(style) || STYLE_TOKENS.some((token) => style.includes(token)))) {
    return true;
  }

  const brewery = norm(tap.brewery_ref);
  if (
    brewery &&
    (EXACT_BREWERY_SENTINELS.has(brewery) ||
      BREWERY_TOKENS.some((token) => brewery.includes(token)) ||
      looksLikeScheduleOrNav(brewery))
  ) {
    return true;
  }

  return false;
}
