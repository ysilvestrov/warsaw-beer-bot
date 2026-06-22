import type { Locale, Translator } from '../../i18n/types';
import { fmtAbv as fmtAbvLocale } from '../../i18n/format';
import { beerNameHtml } from './beer-link';
import { escapeHtml } from './html';

export interface CandidateTap {
  beer_id: number | null;
  untappd_id: number | null;
  display: string;          // human-readable "Brewery BeerName"
  brewery_norm: string;     // for fallback grouping key
  name_norm: string;        // for fallback grouping key
  style: string | null;
  abv: number | null;
  rating: number | null;
  pub_name: string;
}

export interface BeerGroup {
  display: string;
  style: string | null;
  untappd_id: number | null;
  rating: number | null;
  abv: number | null;
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
    {
      display: string;
      untappd_id: number | null;
      bestRating: number | null;
      style: string | null;
      abv: number | null;
      pubs: Set<string>;
    }
  >();
  for (const t of taps) {
    const k = groupKey(t);
    const cur = acc.get(k);
    if (!cur) {
      acc.set(k, {
        display: t.display,
        untappd_id: t.untappd_id,
        bestRating: t.rating,
        style: t.style,
        abv: t.abv,
        pubs: new Set([t.pub_name]),
      });
      continue;
    }
    cur.pubs.add(t.pub_name);
    if (t.rating !== null && (cur.bestRating === null || t.rating > cur.bestRating)) {
      cur.display = t.display;
      // Track the rep tap's style and ABV alongside its display string so they stay
      // consistent for the user.
      if (t.style !== null) cur.style = t.style;
      if (t.abv !== null) cur.abv = t.abv;
    }
    cur.bestRating = maxRating(cur.bestRating, t.rating);
    if (cur.style === null && t.style !== null) cur.style = t.style;
    if (cur.abv === null && t.abv !== null) cur.abv = t.abv;
  }
  return [...acc.values()].map((g) => ({
    display: g.display,
    style: g.style,
    untappd_id: g.untappd_id,
    rating: g.bestRating,
    abv: g.abv,
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

// Re-export so existing callers keep their single import surface here.
export { escapeHtml };

export const fmtStyle = (style: string | null): string =>
  style === null ? '' : ` • ${escapeHtml(style)}`;

export const fmtRating = (r: number | null): string =>
  r === null ? '⭐ —' : `⭐ ${r.toFixed(2).replace(/\.?0+$/, '')}`;

// Re-export the locale-aware ABV formatter under the original name so callers
// (route-format.ts) keep a single import surface.
export { fmtAbvLocale as fmtAbv };

export function formatGroupedBeers(
  groups: BeerGroup[],
  locale: Locale,
  t: Translator,
  opts: { topN?: number; maxPubs?: number } = {},
): string {
  const { topN = 15, maxPubs = 3 } = opts;
  const lines: string[] = [];
  groups.slice(0, topN).forEach((g, i) => {
    const nameHtml = beerNameHtml(g.display, g.untappd_id);
    const head = `${i + 1}. ${nameHtml}${fmtStyle(g.style)}  ${fmtRating(g.rating)}${fmtAbvLocale(locale, g.abv)}`;
    const shown = g.pubs.slice(0, maxPubs).map(escapeHtml).join(', ');
    const extra =
      g.pubs.length > maxPubs ? t('newbeers.more_pubs_suffix', { extra: g.pubs.length - maxPubs }) : '';
    lines.push(head, `     · ${shown}${extra}`);
  });
  return lines.join('\n');
}
