import { breweryCore } from '../sources/ontap/identity';

// #430: the enforcer writes nothing until a week of shadow logs has been compared with
// what the model decided for the same rows. Flipping this to false is the whole change.
// The reason this is not shipped live: the defect that motivated it was a rule that ran
// unattended for six days and destroyed rows nobody was watching.
export const SHADOW_ONLY = true;

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
];

// Drinks Untappd lists and our matcher resolves every day: 1339 rows in our own
// catalogue carry a Cider/Mead/Kvass style, and 10 more carry a Kombucha style
// (Hard Kombucha / Jun, Non-Alcoholic - Kombucha). Being wrong toward eligible costs
// one search; being wrong toward not_a_beer is irreversible. #430.
export const ELIGIBLE_TOKENS = [
  'cydr', 'cider', 'kwas chlebowy', 'kvass', 'квас', 'mead', 'melomel', 'kombucha',
] as const;

// The triage prompt must not restate the boundary in prose — two independent
// statements of one rule is exactly what let the prompt bury cider for six days
// while this module was keeping it eligible. #430.
export function eligibleFamiliesForPrompt(): string {
  return ELIGIBLE_TOKENS.join(', ');
}

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
  'wódka ziemniaczana',
  'własny koktajl z kija',
]);

// Bare 'wine' (English) is deliberately absent: measured 2026-08-22 against our own
// matched catalogue, it collides with real cider/mead producers whose BRAND merely
// contains the word — 'WINE BOYZ BAND & SPOKO' (Cider - Dry), 'Hidden Legend Winery'
// (Mead - Melomel), 'Gut Wine' (Cider - Dry). Same asymmetry as NON_BEER_NAME_TOKENS
// below: a bare wine-family word is never safe as a brewery substring. 'wino'/'vino'/
// 'vini' stay — WINO KARPATIA / VINO KARPATIA are measured leaks this list must still
// catch (scripts/retire-resolved-orphans.test.ts depends on the Polish spelling too) —
// but bare English 'wine' buys nothing no other token here already covers. #430.
const BREWERY_TOKENS = [
  'wino',
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

  // #430: the eligible short-circuit must see the same three fields
  // classifyOrphanAsNonBeer does — style alone misses it on the 64/83 measured rows
  // where style is NULL and the drink family is only visible in the name (a cider
  // sold by a "Winery"-named producer, a mead, a kvass). Substring, deliberately
  // generous: a false "eligible" costs one Untappd search, a false exclusion here is
  // silent and never revisited (#306).
  const eligibleHaystack = norm(`${tap.style ?? ''} ${tap.brewery_ref ?? ''} ${tap.beer_ref ?? ''}`);
  if (ELIGIBLE_TOKENS.some((token) => eligibleHaystack.includes(token))) {
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

// Every surviving token was measured word-boundary against all 31224 matched beers in
// production (name + style) and hits ZERO real beers as a whole word. The seven tokens
// removed after that measurement hit 29 real beers between them: spritz 9 (e.g. "Bean &
// Citrus Spritz", "Sicilian Spritz"), mojito 8 ("Emerald Mojito Gose"), vodka 4 ("Tatanka
// Vodka Edition"), aperitivo 3 ("Aperitivo Stout"), sangria 3 ("Mystic Sangria"),
// prosecco 1, frizzante 1. "Already an orphan" does not remove that population — a beer
// that normally matches can orphan for an unrelated reason (alias gap, query noise) and
// then get sealed permanently, so only zero-collision tokens are safe here. Also never a
// bare wine token — 268 matched beers carry wine/wino/vino (barleywine, barrel ageing)
// and 257 carry a food word. #430.
export const NON_BEER_NAME_TOKENS = ['aperol', 'nalewka', 'szprycer', 'wódka', 'wodka'] as const;

export interface OrphanBoundaryInput {
  brewery: string;
  name: string;
  style: string | null;
  candidates_count: number;
}

// Word set, not substring search: `\b` in JS is ASCII-only and would break on `wódka`,
// and a substring test puts `wine` inside `Dwinell` and `spritz` inside `spritzered`.
function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

// Runs ONLY on a row that has already failed an Untappd search. That condition is what
// makes a name-side test safe: every dangerous beer above matched, so it is never here.
export function classifyOrphanAsNonBeer(
  row: OrphanBoundaryInput,
): { nonBeer: true; token: string } | null {
  // 1. Untappd returned something — let the model judge it.
  if (row.candidates_count !== 0) return null;

  const haystack = `${row.brewery} ${row.name} ${row.style ?? ''}`.toLowerCase();

  // 2. An eligible family named anywhere wins, and wins as a SUBSTRING: the asymmetry
  //    says a false "eligible" costs one search while a false not_a_beer is forever.
  if (ELIGIBLE_TOKENS.some((token) => haystack.includes(token))) return null;

  // 3. A non-beer category word, on a word boundary.
  const bag = words(haystack);
  const hit = NON_BEER_NAME_TOKENS.find((token) => bag.has(token));
  return hit ? { nonBeer: true, token: hit } : null;
}
