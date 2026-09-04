import type { DB } from '../../storage/db';
import type { Checkin } from '../../sources/untappd/export';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { addCoverage, coverageFor } from '../../storage/checkin_coverage';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';

// #587: експорт доводить суцільність своєї історії — записуємо це як покриття. Без цього
// свідчення синхронізація потім не має звідки знати, що вже покрито, і починає вгадувати.
//
// `/import` пише партіями (BATCH_SIZE у import.ts), тож один виклик — це фрагмент ОДНОГО
// файлу, не весь файл. Доведений діапазон належить файлу цілком (Untappd гарантує повноту
// історії від найстаршого до найновішого рядка), а не довільній межі партії — інакше межа
// партії лишає штучну діру там, де файл насправді суцільний. Тому нову партію зливаємо не
// саму із собою, а з усім, що покриття вже знає про цього користувача: кожен `/import`
// заявляє «це повна історія», і ця заявка законно поглинає будь-яке раніше відоме покриття.
export function importCheckins(db: DB, telegramId: number, rows: Checkin[]): void {
  let minId: number | null = null;
  let maxId: number | null = null;

  db.transaction(() => {
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
    if (minId !== null && maxId !== null) {
      let lo = minId;
      let hi = maxId;
      for (const range of coverageFor(db, telegramId)) {
        if (range.from_id < lo) lo = range.from_id;
        if (range.to_id > hi) hi = range.to_id;
      }
      addCoverage(db, telegramId, lo, hi);
    }
  })();
}
