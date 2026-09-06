import type { DB } from '../../storage/db';
import type { Checkin } from '../../sources/untappd/export';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';

// #587: імпорт доводить, що ми маємо кожен рядок ЦЬОГО файлу — але не те, що файл є
// повною й актуальною історією без дір. Обірвана на пів-дороги вигрузка парситься без
// помилки й просто дає менше рядків; стара вигрузка може містити рядок, якого на Untappd
// уже нема, і роздути власний лічильник. Рев'ю PR #592 знайшло третій, незалежний спосіб
// обійти саме цю умову (дублікати id в одному файлі накручують кількість рядків без
// накручення діапазону id). Три різні діри в одному й тому самому припущенні — ознака, що
// припущення хибне саме як припущення, а не що чергову діру можна залатати. Тому імпорт
// більше НЕ заявляє покриття: злиття рядків лишається (це доведено самим фактом їхнього
// парсингу), а заявку про суцільність історії робить лише перший живий обхід розширення
// (`checkin_coverage`, §3.15 spec.md) — той самий механізм, що замінив сид міграції 29.
export function importCheckins(db: DB, telegramId: number, rows: Checkin[]): void {
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
    }
  })();
}
