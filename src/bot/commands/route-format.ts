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
}

export function formatRouteResult(opts: FormatRouteOpts): string {
  const { N, distanceMeters, pubsInOrder } = opts;
  const km = (distanceMeters / 1000).toFixed(1);
  const lines: string[] = [];
  lines.push(
    `Знайдено маршрут для <b>${N}</b> (чи більше) нових пив, відстань ≈ <b>${km} км</b>, пабів у маршруті: <b>${pubsInOrder.length}</b>.`,
  );
  pubsInOrder.forEach((p, i) => {
    lines.push('');
    lines.push(`<b>${i + 1}. ${escapeHtml(p.name)}</b>`);
    for (const beer of p.beers) {
      lines.push(`     • <b>${escapeHtml(beer.display)}</b>  ${fmtRating(beer.rating)}${fmtAbv(beer.abv)}`);
    }
  });
  return lines.join('\n');
}
