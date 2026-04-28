import type { Locale, Translator } from '../../i18n/types';
import { fmtKm } from '../../i18n/format';
import { escapeHtml, fmtAbv, fmtRating } from './newbeers-format';

export interface RouteBeerLine {
  display: string;       // "Brewery BeerName"
  rating: number | null;
  abv: number | null;
}

export interface RoutePubFormat {
  name: string;
  beers: RouteBeerLine[]; // already deduped + ranked by caller
}

export interface FormatRouteOpts {
  N: number;
  distanceMeters: number;
  pubsInOrder: RoutePubFormat[];
  locale: Locale;
  t: Translator;
}

export function formatRouteResult(opts: FormatRouteOpts): string {
  const { N, distanceMeters, pubsInOrder, locale, t } = opts;
  const km = fmtKm(locale, distanceMeters);
  const lines: string[] = [];
  lines.push(t('route.header', { count: N, km, pubs: pubsInOrder.length }));
  pubsInOrder.forEach((p, i) => {
    lines.push('');
    lines.push(`<b>${i + 1}. ${escapeHtml(p.name)}</b>`);
    for (const beer of p.beers) {
      lines.push(
        `     • <b>${escapeHtml(beer.display)}</b>  ${fmtRating(beer.rating)}${fmtAbv(locale, beer.abv)}`,
      );
    }
  });
  return lines.join('\n');
}
