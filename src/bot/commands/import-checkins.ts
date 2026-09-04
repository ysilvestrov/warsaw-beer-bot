import type { DB } from '../../storage/db';
import type { Checkin } from '../../sources/untappd/export';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin, countCheckins } from '../../storage/checkins';
import { addCoverage } from '../../storage/checkin_coverage';
import { getSyncState } from '../../storage/checkin_sync_state';
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
//
// Тут НЕ пишемо покриття: те, що ми злили кожен рядок файлу, не доводить, що файл
// повний (обірвана вигрузка парситься так само чисто й просто дає менше рядків).
// Заявку про покриття робить окремо `sealImportCoverage`, коли зовнішнє свідчення
// це підтверджує.
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
    return { minId: lo, maxId: hi };
  })();
}

// #587: імпорт доводить, що ми маємо КОЖЕН рядок цього файлу, — але не те, що файл
// повний. Обірвана на пів-дороги вигрузка парситься без помилки й просто дає менше рядків. Тому
// заявку про покриття підтверджує лише зовнішнє свідчення — той самий лічильник профілю,
// яким користується міграція 29. Немає лічильника — немає заявки: перший обхід чесно
// пройде цю історію сам.
export function sealImportCoverage(
  db: DB,
  telegramId: number,
  bounds: ImportBounds | null,
): boolean {
  if (bounds === null) return false;
  const { profile_total } = getSyncState(db, telegramId);
  if (profile_total === null || countCheckins(db, telegramId) < profile_total) return false;
  addCoverage(db, telegramId, bounds.minId, bounds.maxId);
  return true;
}
