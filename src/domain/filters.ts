import { canonicalStyleFamily } from './style-family';

export interface TapView {
  beer_id: number | null;
  style: string | null;
  abv: number | null;
  u_rating: number | null;
}

export interface FilterOpts {
  styles?: string[];
  min_rating?: number | null;
  abv_min?: number | null;
  abv_max?: number | null;
}

export function topStyleFamilies(
  currentTapStyles: (string | null)[],
  activeStyles: string[],
  n = 10,
): string[] {
  const counts = new Map<string, number>();
  for (const s of currentTapStyles) {
    // Skip absence-of-style (null/empty) so it doesn't inflate the Other
    // bucket in the ranking; a non-empty unmatched style still counts as Other.
    if (s == null || s.trim() === '') continue;
    const fam = canonicalStyleFamily(s);
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([fam]) => fam);

  const present = new Set(top.map((f) => f.toLowerCase()));
  const extraActive = activeStyles
    .filter((f) => !present.has(f.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  return [...top, ...extraActive];
}

export interface AbvPreset {
  key: string;
  label: string;
  min: number | null;
  max: number | null;
}

// Open-ended thresholds (not closed bands): a cap (`≤X`, max set) or a
// floor (`X+`, min set). Single-select. `≤5%` and `9%+` keep the (min,max)
// of the old bands so prior selections stay valid.
export const ABV_PRESETS: ReadonlyArray<AbvPreset> = [
  { key: 'lte3_5', label: '≤3.5%', min: null, max: 3.5 },
  { key: 'lte5', label: '≤5%', min: null, max: 5 },
  { key: 'gte5', label: '5%+', min: 5, max: null },
  { key: 'gte7', label: '7%+', min: 7, max: null },
  { key: 'gte9', label: '9%+', min: 9, max: null },
];

export function bucketForRange(abvMin: number | null, abvMax: number | null): string | null {
  const b = ABV_PRESETS.find((x) => x.min === abvMin && x.max === abvMax);
  return b ? b.key : null;
}

// Honest display of the stored ABV range, independent of whether it matches a
// preset — so a stale bounded range (e.g. an old 5–7% band) is visible in the
// summary rather than silently filtering. null → caller shows "any".
export function formatAbvRange(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min == null) return `≤${max}%`;
  if (max == null) return `${min}%+`;
  return `${min}–${max}%`;
}

export function filterInteresting<T extends TapView>(
  taps: T[], tried: Set<number>, opts: FilterOpts,
): T[] {
  return taps.filter((t) => {
    if (t.beer_id == null) return false;
    if (tried.has(t.beer_id)) return false;
    if (opts.min_rating != null && (t.u_rating ?? 0) < opts.min_rating) return false;
    if (opts.abv_min != null && (t.abv ?? 0) < opts.abv_min) return false;
    if (opts.abv_max != null && (t.abv ?? 0) > opts.abv_max) return false;
    if (opts.styles && opts.styles.length) {
      const fam = canonicalStyleFamily(t.style);
      if (!opts.styles.some((x) => x.toLowerCase() === fam.toLowerCase())) {
        return false;
      }
    }
    return true;
  });
}

export function rankByRating<T extends { beer_id: number | null; u_rating: number | null }>(
  taps: T[],
): T[] {
  return [...taps].sort(
    (a, b) => (b.u_rating ?? 0) - (a.u_rating ?? 0) || (a.beer_id ?? 0) - (b.beer_id ?? 0),
  );
}
