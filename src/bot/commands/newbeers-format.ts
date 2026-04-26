export interface CandidateTap {
  beer_id: number | null;
  beer_ref: string;
  brewery_norm: string;
  name_norm: string;
  rating: number | null;
  pub_name: string;
}

export interface BeerGroup {
  display: string;
  rating: number | null;
  pubs: string[];
}

const groupKey = (t: CandidateTap): string =>
  t.beer_id !== null ? `id:${t.beer_id}` : `nb:${t.brewery_norm}|${t.name_norm}`;

const maxRating = (a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
};

export function groupTaps(taps: CandidateTap[]): BeerGroup[] {
  const acc = new Map<
    string,
    { display: string; bestRating: number | null; pubs: Set<string> }
  >();
  for (const t of taps) {
    const k = groupKey(t);
    const cur = acc.get(k);
    if (!cur) {
      acc.set(k, { display: t.beer_ref, bestRating: t.rating, pubs: new Set([t.pub_name]) });
      continue;
    }
    cur.pubs.add(t.pub_name);
    if (t.rating !== null && (cur.bestRating === null || t.rating > cur.bestRating)) {
      cur.display = t.beer_ref;
    }
    cur.bestRating = maxRating(cur.bestRating, t.rating);
  }
  return [...acc.values()].map((g) => ({
    display: g.display,
    rating: g.bestRating,
    pubs: [...g.pubs].sort((a, b) => a.localeCompare(b)),
  }));
}

export function rankGroups(groups: BeerGroup[]): BeerGroup[] {
  return [...groups].sort((a, b) => {
    const ra = a.rating ?? -Infinity;
    const rb = b.rating ?? -Infinity;
    if (rb !== ra) return rb - ra;
    if (b.pubs.length !== a.pubs.length) return b.pubs.length - a.pubs.length;
    return a.display.localeCompare(b.display);
  });
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtRating = (r: number | null): string =>
  r === null ? '⭐ —' : `⭐ ${r.toFixed(2).replace(/\.?0+$/, '')}`;

export function formatGroupedBeers(
  groups: BeerGroup[],
  opts: { topN?: number; maxPubs?: number } = {},
): string {
  const { topN = 15, maxPubs = 3 } = opts;
  const lines: string[] = [];
  groups.slice(0, topN).forEach((g, i) => {
    const head = `${i + 1}. <b>${escapeHtml(g.display)}</b>  ${fmtRating(g.rating)}`;
    const shown = g.pubs.slice(0, maxPubs).map(escapeHtml).join(', ');
    const extra = g.pubs.length > maxPubs ? ` +${g.pubs.length - maxPubs} інших` : '';
    lines.push(head, `     · ${shown}${extra}`);
  });
  return lines.join('\n');
}
