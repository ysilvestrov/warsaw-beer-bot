import { breweryCore } from '../sources/ontap/identity';

export interface OntapNonBeerInput {
  style: string | null;
  brewery_ref: string | null;
  beer_ref?: string | null;
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
  'cocktail',
  'nalewka',
  'szprycer',
  'glera',
  'musujące',
  'wytrawne',
  'półwytrawne',
  'słodkie',
  'soft drink',
  'wódka',
  'wodka',
  'vodka',
  'sangria',
];

// Drinks Untappd lists and our matcher resolves every day: 1339 rows in our own
// catalogue carry a Cider/Mead/Kvass style, and 10 more carry a Kombucha style
// (Hard Kombucha / Jun, Non-Alcoholic - Kombucha). Being wrong toward eligible costs
// one search; being wrong toward not_a_beer is irreversible. #430.
export const ELIGIBLE_TOKENS = [
  'cydr', 'cider', 'kwas chlebowy', 'kvass', 'квас', 'mead', 'melomel', 'kombucha',
] as const;

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
  'frizzante',
  'cantine',
  'cantina',
  'aperitivo',
  'san martino',
  'conegliano',
  'puglia',
  'vini',
  'vino',
  'dolium vini',
  'stacja winiarska',
  'kofola',
  'sangria',
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
  const style = norm(tap.style);
  if (style && ELIGIBLE_TOKENS.some((token) => style.includes(token))) {
    return false;
  }
  if (style && (EXACT_STYLE_PHRASES.has(style) || STYLE_TOKENS.some((token) => style.includes(token)))) {
    return true;
  }

  const brewery = norm(tap.brewery_ref);
  if (
    brewery &&
    (EXACT_BREWERY_SENTINELS.has(brewery) ||
      EXACT_BREWERY_SENTINELS.has(norm(breweryCore(brewery))) ||
      BREWERY_TOKENS.some((token) => brewery.includes(token)) ||
      looksLikeScheduleOrNav(brewery))
  ) {
    return true;
  }

  return false;
}

// Shop-UI placeholders scraped as a tap: "temporarily out", "drunk up", "tap out of service".
// Substring match on BOTH fields — "Guinness Chwilowy brak:(" means the Guinness ran out, it
// is not a beer with that name. Curated phrases only, never a regex heuristic: this is a finite
// set of shop strings, and a false drop is invisible while a missed placeholder stays a visible
// orphan (#306).
const PLACEHOLDER_PHRASES = [
  'chwilowy brak',
  'kran w serwisie',
  'czeka na lepsze czasy',
  'kran pusty',
];

// Single common words are risky as a substring match (e.g. "wypite" inside a longer beer
// name) — unlike the multi-word phrases above, these must equal the WHOLE normalized value.
const PLACEHOLDER_EXACT = new Set([
  'wypite',
]);

function isPlaceholder(value: string): boolean {
  const v = norm(value);
  if (v === '') return false;
  return PLACEHOLDER_EXACT.has(v) || PLACEHOLDER_PHRASES.some((phrase) => v.includes(phrase));
}

export type TapExclusion = 'non-beer' | 'placeholder';

// Why a tap must not become a snapshot row, or null when it is a normal beer.
export function ontapTapExclusion(tap: OntapNonBeerInput): TapExclusion | null {
  if (isPlaceholder(tap.beer_ref ?? '') || isPlaceholder(tap.brewery_ref ?? '')) {
    return 'placeholder';
  }
  return isOntapNonBeerTap(tap) ? 'non-beer' : null;
}
