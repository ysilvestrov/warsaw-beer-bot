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
  ['van honsebrouck', 'kasteel vanhonsebrouck'],
  ['kasteel vanhonsebrouck', 'bacchus'],
  ['weihenstephaner', 'bayerische staatsbrauerei weihenstephan'],
  ['hopbrook', 'hop brook'],
  ['starkaft', 'starkraft'],
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
