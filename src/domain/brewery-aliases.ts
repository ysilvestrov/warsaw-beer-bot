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
