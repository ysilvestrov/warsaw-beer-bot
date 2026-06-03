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

export function familyOf(style: string | null): string | null {
  if (style == null) return null;
  const trimmed = style.trim();
  if (trimmed === '') return null;
  const idx = trimmed.indexOf(' - ');
  const fam = (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim();
  return fam === '' ? null : fam;
}

export function topStyleFamilies(
  currentTapStyles: (string | null)[],
  activeStyles: string[],
  n = 10,
): string[] {
  const counts = new Map<string, number>();
  for (const s of currentTapStyles) {
    const fam = familyOf(s);
    if (fam == null) continue;
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
