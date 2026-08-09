// Shop-agnostic baseline detector for non-beer products (packs / sets / gift vouchers).
// Matches only MULTI-WORD packaging phrases plus a few unambiguous single words, never bare
// ambiguous words like "box"/"glass"/"puszka" — so real beers ("Beer in a Box", a can with a
// deposit) stay. Glassware/apparel and soft-drink categories are NOT handled here (they have
// no safe shared name token) — those are shop-local (onemorebeer merch tokens / page gate).
// Adapters keep the final say; this is a reusable baseline, not a mandatory gate.
const NON_BEER_NAME_RE = new RegExp(
  [
    'brewery pack',
    'vertical set',
    'tasting set',
    'tasting box',
    'beer package',
    'beerpackage',
    'beer box',
    'beerbox',
    'advent calendar',
    'surprise box',
    'signature box',
    'craftbeer box',
    // Bounded on BOTH sides: the right \b keeps "Energy Drinkability IPA" a beer, the
    // left one keeps "Bioenergy Drink IPA" one too. `s?` keeps the plural, which is the
    // commoner shelf spelling and would be lost to a bare trailing boundary.
    '\\benergy drinks?\\b',
    'gift set',
    'gift box',
    'gift pack',
    'gift certificate',
    'mixed pack',
    'mixed case',
    'twelve pack\\b',
    'variety pack\\b',
    'variety twelve pack\\b',
    'subscription',   // unambiguous: no beer is named "Subscription"
    'abonnement',
    'certificate',    // EN gift voucher
    'zestaw',         // PL: set/kit
    'pakiet',         // PL: package
    'набір',          // UA: set/kit
    'сертифікат',     // UA: voucher
    'пакування',      // UA: packaging (e.g. "Подарункове пакування замовлення")
    '\\+ ?келих',     // UA: "+ glass" merch bundle (winetime sets)
    '\\+ ?szklank',   // PL: "+ glass"
    '\\+ ?glass',     // EN: "+ glass"
  ].join('|'),
  'iu',
);

export function isNonBeerName(name: string): boolean {
  return NON_BEER_NAME_RE.test(name);
}

// "Ginger beer" and "root beer" are the names English gave to two non-fermented soft
// drinks — but alcoholic versions of both exist and are on Untappd. So the family alone
// decides nothing; only family + a published 0% does. When the shop publishes no ABV we
// KEEP the product: a stray orphan row is cheaper than silently hiding a real beer.
//
// Callers must match the family against the FULL brewery+name string, not the post-split
// name alone: brewery/name splitting can hand the leading brand token ("Ginger") to the
// brewery, leaving "Beer" alone in the name, which would otherwise escape this gate
// (#376 follow-up).
//
// When the shop also publishes a style, the STYLE — not the name — decides:
//   - style absent            → fall back to guessing from name/brewery+name, as above
//   - style matches the family (e.g. "Ginger beer") → drop, the shop confirms the soft drink
//   - style is anything else (e.g. "Stout")          → KEEP, the shop just told us this is
//     a real 0.0% beer that merely happens to mention "ginger beer"/"root beer" in its name
// A published style always outranks a name guess — never let the name override it.
//
// This gate is scoped to that family and must never be generalised into "0.0% is not
// beer" — see shared/abv.ts: 0 is a legitimate value and the only thing separating
// AleBrowar Kwas Chlebowy Bright (0.0%) from Light (0.5%).
const SOFT_DRINK_FAMILY_RE = /\b(?:ginger|root)\s+beer\b/iu;

export function isNonAlcoholicSoftDrinkFamily(
  fields: { name: string; style?: string; abv?: number },
): boolean {
  if (fields.abv !== 0) return false;
  // An empty/whitespace style is not a published style — a shop that renders the row
  // with no value has told us nothing, so fall back to the name rather than letting
  // "" veto the drop.
  const style = fields.style?.trim();
  if (style) return SOFT_DRINK_FAMILY_RE.test(style);
  return SOFT_DRINK_FAMILY_RE.test(fields.name);
}
