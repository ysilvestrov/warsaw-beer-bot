// Finite, hand-curated brewery equivalences for the brewery hard-gate (#202).
// Each entry is a pair of NORMALIZED brewery forms (exactly what
// normalizeBrewery() produces — verify new entries with scripts/brewery-alias-key.ts).
// The map is symmetric but NON-TRANSITIVE: only the listed pairs match, so two
// forms that share a partner (van honsebrouck & bacchus both pair with kasteel
// vanhonsebrouck) do NOT thereby become equivalent to each other.
//
// This is a deliberately small, explicit list. Do NOT add fuzzy/general brewery
// matching here. Grow it only from confirmed orphan-triage misses, one reviewed
// pair at a time (see docs/debug-orphan-matching.md).
const ALIAS_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['nepomucen', 'nepo'],
  ['napomucen', 'nepo'],
  ['van honsebrouck', 'kasteel vanhonsebrouck'],
  ['kasteel vanhonsebrouck', 'bacchus'],
  ['weihenstephaner', 'bayerische staatsbrauerei weihenstephan'],
  ['hopbrook', 'hop brook'],
  ['starkaft', 'starkraft'],
  ['umanpivo', 'уманьпиво'],
  ['grimbergen', 'alken maes'],
  ['wroclove', 'witnica'],
  ['poutnik', 'pelhrimov'],
  ['jezek kwasnicowy', 'jihlava'],
  // #318 batch (2026-07-19): live on-tap + shop gate-miss aliases, each verified
  // against the orphan's enrich_failures.candidates_summary (authoritative Untappd
  // brewery) and normalized via `npm run alias-key`.
  ['aecht schlenkerla', 'schlenkerla'],
  ['lausitzer', 'privatbrauerei eibau'],
  ['grybow pilsvar', 'pilsvar'],
  ['cydr dobronski', 'jnt group'],
  ['prerov', 'zubr'],
  ['bakalar', 'tradicni v rakovniku'],
  ['dzik', 'cydrownia'],
  // brand-as-brewery (shop put a beer/brand in the brewery field; confirmed 1:1):
  ['panipani', 'trzech kumpli'],
  ['smoothiemaker', 'mad brew'],
  // shop (extension) sources:
  ['vibrant pour', 'vibrantpour'],
  ['drofa', 'дрофа'],
  // #329 batch (2026-07-20): gate-miss aliases, each verified against the orphan's
  // enrich_failures.candidates_summary (authoritative Untappd brewery) and the real
  // matcher name stage (only rows whose name already matches post-alias — see the
  // #329 design doc). Name-divergent misses were routed to #319, not aliased here.
  ['ziemia obiacana', 'ziemia obiecana'],      // brewery typo OBIACANA->OBIECANA; 4 beers
  ['bergqell', 'bergquell lobau'],             // Erdbeer (Porter style-stripped)
  ['bracki zamkowy w cieszynie', 'arcyksiazecy zamkowy cieszyn'], // Cieszyn Pilsner
  ['tank busters', 'tankbusters'],             // Paranormal Activity
  // Měšťanský-pivovar batch (2026-07-21): Czech locative declension. After the
  // `mestansky` noise strip the shop "Polička" normalizes to `policka` and the
  // Untappd "Měšťanský pivovar v Poličce" to `v policce`. Verified via alias-key.
  ['policka', 'v policce'],
  // #325 (2026-07-22): Kraftwerk & Remeslo share an owner and are routinely conflated
  // by shops (the shop filed "Remeslo Wiedeński Lager" under brewery "Kraftwerk"; the
  // beer is Untappd's `Remeslo Brewery — Vienna Lager`, bid 3843080). Verified via
  // alias-key. NB: this pair fixes the brewery GATE for that owner's English-named
  // beers; the Wiedeński→Vienna style-word gap is tracked separately (see #325 issue).
  ['kraftwerk', 'remeslo'],
  // #327 comment (2026-07-22): St. James's Gate IS Guinness's Dublin brewery, so
  // shops that file the real brewery name ("St. James's Gate Brewery / Guinness
  // Draught") miss the Untappd brewery `Guinness`. Factual same-brewery pair, safe.
  // Rescues 219 (Guinness Draught); the bare-"Guinness"-name misses (11851) are a
  // name-stage issue, not a gate issue. Verified via alias-key.
  ['st james s gate', 'guinness'],
  // #347 batch (2026-08-14): gate misses where the search returned the beer at the
  // shop's own ABV and only the brewer label diverged. Every pair was verified by
  // replaying the orphan live through lookupBeer() against Algolia before curating;
  // keys produced with `npm run alias-key`. See
  // docs/superpowers/specs/2026-08/2026-08-14-347-brewery-alias-batch-design.md
  ['ksiazece', 'tyskie ksiazece'],   // 33544 Złote Pszeniczne -> bid 323265, abv 4.9 = 4.9
  ['petrus', 'de brabandere'],       // 33571 Kriek -> bid 6682946, abv 4.0 = 4.0 (Petrus is a De Brabandere brand)
  ['kacov', 'hubertus'],             // 33664 Hořký ležák L.P. 1457 -> bid 2204361, abv 4.4 = 4.4
  // Morphological variant ("Mazurskie Brewery" / "Mazurski Browar"), not a brand
  // relation; same shape as ['ziemia obiacana', 'ziemia obiecana']. Redundant if
  // #407 ever adds an edit-distance rescue to the gate.
  ['mazurskie', 'mazurski'],         // 34252 Lager Ciemny -> bid 4586540, abv 5.1 = 5.1
  // Portfolio owner: the shop files group beers under "Lobkowicz". A hub, so the
  // two group breweries never become equivalent to each other.
  ['lobkowicz', 'jihlava'],          // 11995 Ježek Kvasnicový -> bid 71011, abv 4.9 = 4.9
  ['lobkowicz', 'rychtar'],          // 34336 Rychtář Premium -> bid 301434, abv 5.0 = 5.0

  ['cieszyn', 'arcyksiazecy zamkowy cieszyn'], // 34371 Pszeniczne -> bid 1036654, abv 5.4 = 5.4
  // Cidre Royal is the brand of the Ukrainian producer Royal Fruit Garden; the
  // Belarusian licensee (Royal Fruit Bel) is deliberately NOT paired — no observed
  // row belongs to it. 34518 is also pinned in production for durability, even
  // though the pair alone already selects the right record.
  ['cidre royal', 'royal fruit garden'], // 34518 Apple Cider -> bid 402651, abv 5.0 = 5.0; the unpaired Belarusian licensee (Royal Fruit Bel) is gated out, so the pick is forced rather than arbitrary
  // Tomatøl is a Mad Brew series filed as a brewery, exactly like smoothiemaker
  // above. Server-side twin of the client-side #385/#384 fixes, so 0.13.0 clients
  // benefit too.
  ['tomatol', 'mad brew'],           // 34352 Wasabi -> bid 6819716, abv 3.8 = 3.8; also 34351 Bulgogi -> bid 6648348 (shop 3.8 vs record 4.2)
  // Necessary but not sufficient for 34642: after the gate opens, WEIZENBIER vs
  // Weizen still fails the name stage (#322 / #334).
  ['nachod', 'primator'],            // 34642 Weizenbier -> bid 30947, abv 4.7 vs 4.8
  ['stern scheubel', 'stern brau gunter scheubel'], // 30142 Vollbier Hell -> bid 1181659, abv 5.0 = 5.0
];

// normForm -> directly-paired forms. Built once at module load.
const NEIGHBORS: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  const add = (k: string, v: string) => {
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    if (!arr.includes(v)) arr.push(v);
  };
  for (const [a, b] of ALIAS_PAIRS) {
    add(a, b);
    add(b, a);
  }
  return m;
})();

// Directly-paired curated partners of a normalized brewery form (empty if none).
// Returns a fresh copy so callers can sort/mutate without corrupting the shared map.
export function aliasNeighbors(normForm: string): string[] {
  return (NEIGHBORS.get(normForm) ?? []).slice();
}

// Every normalized form that appears in ALIAS_PAIRS (both sides of every pair).
const ALIAS_KEYS: ReadonlySet<string> = new Set(NEIGHBORS.keys());

// The set of curated-alias keys — used to decide whether a brewery is covered by
// the curated layer at all (see hasCuratedAlias in matcher.ts).
export function aliasKeys(): ReadonlySet<string> {
  return ALIAS_KEYS;
}
