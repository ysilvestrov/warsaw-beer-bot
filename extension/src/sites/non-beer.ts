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
    'gift set',
    'gift box',
    'gift pack',
    'gift certificate',
    'mixed pack',
    'mixed case',
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
