import type { DB } from './db';

export interface Filters {
  styles: string[];
  min_rating: number | null;
  abv_min: number | null;
  abv_max: number | null;
  default_route_n: number | null;
}

interface Row {
  styles: string | null;
  min_rating: number | null;
  abv_min: number | null;
  abv_max: number | null;
  default_route_n: number | null;
}

export function getFilters(db: DB, telegramId: number): Filters | null {
  const r = db.prepare('SELECT styles, min_rating, abv_min, abv_max, default_route_n FROM user_filters WHERE telegram_id = ?')
    .get(telegramId) as Row | undefined;
  if (!r) return null;
  return {
    styles: r.styles ? JSON.parse(r.styles) : [],
    min_rating: r.min_rating,
    abv_min: r.abv_min,
    abv_max: r.abv_max,
    default_route_n: r.default_route_n,
  };
}

export function setFilters(db: DB, telegramId: number, f: Filters): void {
  db.prepare(
    `INSERT INTO user_filters (telegram_id, styles, min_rating, abv_min, abv_max, default_route_n)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       styles = excluded.styles, min_rating = excluded.min_rating,
       abv_min = excluded.abv_min, abv_max = excluded.abv_max,
       default_route_n = excluded.default_route_n`,
  ).run(telegramId, JSON.stringify(f.styles), f.min_rating, f.abv_min, f.abv_max, f.default_route_n);
}
