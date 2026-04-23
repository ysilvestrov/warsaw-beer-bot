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

export function filterInteresting<T extends TapView>(
  taps: T[], drunk: Set<number>, opts: FilterOpts,
): T[] {
  return taps.filter((t) => {
    if (t.beer_id == null) return false;
    if (drunk.has(t.beer_id)) return false;
    if (opts.min_rating != null && (t.u_rating ?? 0) < opts.min_rating) return false;
    if (opts.abv_min != null && (t.abv ?? 0) < opts.abv_min) return false;
    if (opts.abv_max != null && (t.abv ?? 0) > opts.abv_max) return false;
    if (opts.styles && opts.styles.length) {
      const s = (t.style ?? '').toLowerCase();
      if (!opts.styles.some((x) => s.includes(x.toLowerCase()))) return false;
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
