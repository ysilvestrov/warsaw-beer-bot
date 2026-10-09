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
  // #665: Konrad 12° bid 158057, live Algolia and orphan candidates_summary agree on Vratislavice.
  ['konrad', 'vratislavice nad nisou'],
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
  ['pan ipani', 'trzech kumpli'],
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
  // Cluster 4 batch: parent/portfolio & conglomerate brand resolution (#417, #515, #554, #485, #545).
  // Each pair is proven against an orphan in enrich_failures and rescues it live.
  ['kaunas alus', 'kauno alus'],                          // 368 Tradycynis ciemne z ziołami -> bid 722917, 8.2% = 8.2%
  ['tradycynis', 'kauno alus'],                           // 11875 Kokosowy -> bid 2669724 (5.0%), 11967 Ananasowe -> bid 3255099
  ['cydr flirt tradycynis', 'kauno alus'],                 // 11934 Cydr MANGO -> bid 6720492, 5.0% = 5.0%
  ['cydr flirt', 'kauno alus'],                           // 32561 Ananas -> bid 6235653, 5.0% vs 4.5%
  ['flirt', 'kauno alus'],                                // 31073 Cydr Ananas -> bid 6235653, 4.7% vs 4.5%
  ['rakovnik', 'tradicni v rakovniku'],                   // 12360 Pražačka -> bid 184172, 4.0% = 4.0%
  ['dobruska', 'rodinny rampusak'],                       // 11949 DOBRUŠSKÁ -> bid 654837 (4.4%), 11951 Rampusak 12 -> bid 445768 (4.9%)
  ['jablecznik trzebnicki', 'cydr tradycyjny trzebnica'], // 30135 Cydr tradycyjny -> bid 2132069, 5.2% vs 4.7%
  ['edelweiss', 'brau union osterreich'],                 // 35120 12° Hefetrüb -> bid 93420, 5.1%
  ['rochefort', 'abbaye notre dame de saint remy'],       // 35131 Rochefort 10 -> bid 6766, 11.3% (#545)
  ['samuel smith', 'melbourn bros all saints'],           // 35147 Organic Apricot -> bid 119231, 5.1% (#545)
  ['trio stout', 'united dutch breweries'],               // 25908 Extra CAN -> bid 79060, 7.2% (#545)
  // Cluster 5 batch: bounded brewery-typo rescue (#476).
  // Each pair is proven against an orphan in enrich_failures and rescues it live.
  ['racborz', 'zamkowy raciborz'],                                    // 386 Raciborskie Klasyczne -> bid 4525184, 5.0% = 5.0%
  ['bayerischer banhof', 'bayerischer bahnhof gasthaus gosebrauerei'], // 30145 Oryginal Leipziger Gose -> bid 19030, 4.6% = 4.6%
  // Cluster 3 batch: parent/portfolio brand, cider producer, and divergent brewery suffix resolution (#417, #485, #554, #679).
  // Each pair is proven against an orphan in enrich_failures and rescues it live.
  ['cydr dzik', 'cydrownia'],                                         // 288 Cydr półsłodki -> bid 5441672, 4.5% = 4.5% (#485)
  ['coors', 'blue moon'],                                             // 316 Blue Moon Belgian White Ale -> bid 3839, 5.4% (#417)
  ['san miguel', 'grupo mahou san miguel'],                           // 35041 Lager 0,0% Bezalko -> bid 68137, 0.0% = 0.0% (#554)
  ['schneider weisse', 'schneider weisse g schneider sohn'],           // 35122 12° TAP 7 Original Weissbier -> bid 16335, 5.4% (#554)
  ['beliny krakonos', 'krakonos'],                                    // 35189 Krakonoš 11° -> bid 654837, 4.4% (#554)
  ['gouden carolus', 'het anker'],                                    // 35221 24° Strong Dark Ale Whisky Infused -> bid 10703, 11.7% (#554)
  ['stara zajezdnia krakow by desilva', 'stara zajezdnia krakow'],    // 37542 AIPA 15° -> bid 1472876, 7.0% (#679)
  ['x mark', 'x marks the hops'],                                     // 25924 Flavoured Beer Agave CAN -> bid 6786704, 0.0% (#679)
  ['harpagan', 'poznanskie rzemieslnicze'],                           // 37475 Lager 11° -> bid 6716261, 4.5% (#679)
  ['baraba', 'remedicum'],                                            // 37801 POMERANCOVA 11° -> bid 5910606, 4.3% (#679)
  ['murphys', 'heineken ireland'],                                    // 37909 Murphys -> bid 5932, 4.0% (#679)
  // Cluster batch: parent/portfolio brand, cider producer, and divergent brewery suffix resolution (#417, #483, #462, #302, #338, #659).
  // Each pair is proven against an orphan in enrich_failures and rescues it live.
  ['transcend', 'transcend beer crafters'],              // 37946 Citracalifragilisticexpialidocious -> bid 6086381, 7.0% (#417)
  ['schladminger', 'schladming'],                         // 35098 12° Märzen -> bid 121832, 5.1% (#417)
  ['maisels weisse', 'gebr maisel'],                      // 35109 12° Dunkel -> bid 62309, 5.1% (#417)
  ['nymburg', 'nymburk'],                                 // 30422 Francinuv -> bid 397490, 5.0% (#417)
  ['platan', 'protivin'],                                 // 30059 Platan Jedenáctka -> bid 309422 (4.6%), 34990 Jedenactka 11° (#417)
  ['eeuwige', 'de eeuwige jeugd'],                        // 35035 Bullebak (7.7%), 35101 Gladjanus -> bid 1605620 (5.2%) (#302)
  ['sonnenbrau', 'sonnen brau mursbach'],                 // 34734 Kellebier -> bid 183267, 4.7% = 4.7% (#483)
  ['st bernard', 'st bernardus'],                         // 34958 St. Bernardus Tripel 18° -> bid 481, 8.0% = 8.0% (#462)
  ['hosl', 'privatbrauerei hosl'],                        // 37962 Abt Andreas -> bid 198241, 5.4% vs 4.9% (#659)
  ['terena', 'п ю першии'],                               // 36683 Citra х Nectaron NEIPA -> bid 6678788, 6.3% = 6.3% (#642)
  ['perennial', 'perennial artisan ales'],                // 38063 Colourant (2026) -> bid 5452613, 14.0% (#338)
  ['stiegl', 'stieglbrauerei zu salzburg'],               // 35115 12° Weisse Naturtrüb -> bid 80, 5.1% (#302)
  ['maryensztad', 'maryensztadt'],                        // 12269 Mi to żyto -> bid 6357167, 5.7% = 5.7% (#417)
  ['maryesztadt', 'maryensztadt'],                        // 38547 By Your Side -> bid 6357164, 6.0% = 6.0% (#775)
  ['braurei eichhorn', 'eichhorn dorfleins'],             // 34816 Kellerbier -> bid 343881, 5.0% vs 5.2% (#483)
  // #658 / Cluster #2: brand-as-brewery for conglomerate lines and series brands
  ['kwak', 'bosteels'],                                   // 26101 Pauwel -> Pauwel Kwak (bid 358)
  ['kozel', 'velke popovice'],                            // 35038 Kozel Dark -> Kozel Černý / Dark (bid 70150)
  ['pilsner urquell', 'plzensky prazdroj'],               // 25926 Pilsner Urquell -> Plzeňský Prazdroj
  ['corona extra', 'grupo modelo'],                       // 25927 Corona Extra -> Grupo Modelo
  ['cappuccino', 'mad brew'],                             // 29924 Cappuccino Night Pulse -> Mad Brew
  // Curated brewery alias batch for cider makers and spelling variants (#485, #814).
  // Each pair is proven against an orphan in enrich_failures and rescues it live.
  ['chyliczki', 'cydr chyliczki'],                        // 31246 Cydr Chyliczki - Japoński Sad -> bid 4382570, 7.2% vs 7.0% (#485)
  ['cydr polski', 'cydrownia'],                           // 30028 DZIK -> bid 825830, 4.5% = 4.5% (#485)
  ['magick road', 'magic road'],                          // 38912 Cherry & dark grapes -> bid 6919376, 4.2% = 4.2% (#814)
  ['maddriver', 'mad driver'],                            // 38899 Vermont IPA 7,5° -> bid 2498571, 0.5% = 0.5% (#814)
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
