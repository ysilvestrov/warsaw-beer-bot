import type { DB } from '../../storage/db';
import type { Checkin } from '../../sources/untappd/export';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { addCoverage } from '../../storage/checkin_coverage';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';

export interface ImportBounds {
  minId: number;
  maxId: number;
}

// #587: партії одного файлу — суцільні зрізи одного експорту, тож їхнє об'єднання
// доведене; чужий діапазон — ні. Тому акумулятор передається явно від виклику до
// виклику (а не читається назад із покриття): злити можна тільки те, що справді
// прийшло з ЦЬОГО файлу, інакше стара вигрузка могла б запечатати діру, яку знайшла
// жива синхронізація десь-інде.
export function importCheckins(
  db: DB,
  telegramId: number,
  rows: Checkin[],
  prev: ImportBounds | null = null,
): ImportBounds | null {
  let minId: number | null = null;
  let maxId: number | null = null;

  return db.transaction(() => {
    for (const r of rows) {
      const beerId = upsertBeer(db, {
        untappd_id: r.bid ?? null,
        name: r.beer_name,
        brewery: r.brewery_name,
        style: r.beer_type,
        abv: r.beer_abv,
        rating_global: r.global_rating,
        normalized_name: normalizeName(r.beer_name),
        normalized_brewery: normalizeBrewery(r.brewery_name),
        untappd_id_source: 'checkin',
      });
      mergeCheckin(db, {
        checkin_id: r.checkin_id,
        telegram_id: telegramId,
        beer_id: beerId,
        user_rating: r.rating_score,
        checkin_at: r.created_at,
        venue: r.venue_name,
      });
      const n = Number(r.checkin_id);
      if (Number.isInteger(n) && n > 0) {
        if (minId === null || n < minId) minId = n;
        if (maxId === null || n > maxId) maxId = n;
      }
    }
    if (minId === null || maxId === null) return prev;

    const lo = prev !== null && prev.minId < minId ? prev.minId : minId;
    const hi = prev !== null && prev.maxId > maxId ? prev.maxId : maxId;
    addCoverage(db, telegramId, lo, hi);
    return { minId: lo, maxId: hi };
  })();
}
