import type { DB } from '../../storage/db';
import type { Checkin } from '../../sources/untappd/export';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { addCoverage } from '../../storage/checkin_coverage';
import { getSyncState } from '../../storage/checkin_sync_state';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';

export interface ImportBounds {
  minId: number;
  maxId: number;
  // Рев'ю PR #592 (P1): скільки придатних (числових) рядків насправді дав ЦЕЙ імпорт —
  // не плутати з `countCheckins`, який рахує УСІ рядки користувача з будь-якого джерела.
  // `sealImportCoverage` звіряє profile_total саме з цим лічильником.
  rows: number;
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
  let rowsCount = 0;

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
      // Рев'ю PR #592 (P2): тільки чистий десятковий рядок — так само, як курсор у
      // src/api/routes/checkins.ts. Без цієї перевірки Number() пропустив би '5e2',
      // ' 580 ' чи '0x244' як валідні числа: рядок зберігся б під своїм ЛІТЕРАЛЬНИМ
      // рядковим id, а межі посунулися б за перекрученим числом — покриття тоді могло б
      // заявити id, якого насправді не існує.
      if (/^\d+$/.test(r.checkin_id)) {
        const n = Number(r.checkin_id);
        if (n > 0) {
          if (minId === null || n < minId) minId = n;
          if (maxId === null || n > maxId) maxId = n;
          rowsCount++;
        }
      }
    }
    if (minId === null || maxId === null) return prev;

    const lo = prev !== null && prev.minId < minId ? prev.minId : minId;
    const hi = prev !== null && prev.maxId > maxId ? prev.maxId : maxId;
    const rowsTotal = (prev?.rows ?? 0) + rowsCount;
    return { minId: lo, maxId: hi, rows: rowsTotal };
  })();
}

// #587: імпорт доводить, що ми маємо КОЖЕН рядок цього файлу, — але не те, що файл
// повний. Обірвана на пів-дороги вигрузка парситься без помилки й просто дає менше рядків. Тому
// заявку про покриття підтверджує лише зовнішнє свідчення — той самий лічильник профілю,
// яким раніше користувалося сидування міграції 29 (тепер видалене, рев'ю PR #592 P1).
// Немає лічильника — немає заявки: перший обхід чесно пройде цю історію сам.
//
// Рев'ю PR #592 (P1): звіряти треба з `bounds.rows` — скільки числових рядків дав САМ файл, —
// а не з `countCheckins`, яка рахує УСІ рядки користувача з будь-якого джерела. Приклад:
// 8 рядків уже лежать у БД (жива синхронізація), обірваний імпорт додає 2 і `profile_total = 10`
// — `countCheckins` каже 10 і "підтверджує" заявку, хоча файл насправді дав лише 2 рядки, а не
// всю історію до `[minId, maxId]`. Файл, що дав рядків не менше, ніж профіль каже, що їх є,
// і охоплює `[min,max]`, — містить їх усі; це і є справжній доказ про сам файл.
export function sealImportCoverage(
  db: DB,
  telegramId: number,
  bounds: ImportBounds | null,
): boolean {
  if (bounds === null) return false;
  const { profile_total } = getSyncState(db, telegramId);
  if (profile_total === null || bounds.rows < profile_total) return false;
  addCoverage(db, telegramId, bounds.minId, bounds.maxId);
  return true;
}
