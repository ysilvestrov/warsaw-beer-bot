import type { DB } from './db';
import { getHistoryOwner } from './history-owner';
import { canonicalCheckinAt } from '../domain/checkin-time';

export interface CheckinInput {
  checkin_id: string;
  telegram_id: number;
  account_key?: string;
  beer_id: number | null;
  user_rating: number | null;
  checkin_at: string;
  venue: string | null;
}

export interface CheckinRow extends CheckinInput { id: number; account_key: string; }

export function mergeCheckin(db: DB, c: CheckinInput): void {
  db.prepare(
    `INSERT INTO checkins (checkin_id, telegram_id, account_key, beer_id, user_rating, checkin_at, venue)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id, account_key, checkin_id) DO UPDATE SET
       beer_id = excluded.beer_id,
       user_rating = excluded.user_rating,
       checkin_at = excluded.checkin_at,
       venue = excluded.venue`,
  ).run(c.checkin_id, c.telegram_id, c.account_key ?? getHistoryOwner(db, c.telegram_id).accountKey, c.beer_id, c.user_rating, canonicalCheckinAt(c.checkin_at), c.venue);
}

export function checkinsForUser(db: DB, telegramId: number): CheckinRow[] {
  return db.prepare('SELECT * FROM checkins WHERE telegram_id = ? AND account_key = ? ORDER BY checkin_at DESC')
    .all(telegramId, getHistoryOwner(db, telegramId).accountKey) as CheckinRow[];
}

// Most recent non-null personal rating per beer. Iterates newest-first and
// keeps the first non-null rating seen for each beer_id. Profile beer ratings
// are a fallback only: their observation time is not a check-in timestamp.
export function latestRatingsByBeer(db: DB, telegramId: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of checkinsForUser(db, telegramId)) {
    if (c.beer_id === null || c.user_rating === null) continue;
    if (!out.has(c.beer_id)) out.set(c.beer_id, c.user_rating);
  }
  const profileRatings = db.prepare(
    'SELECT beer_id, user_rating FROM untappd_had WHERE telegram_id = ? AND account_key = ? AND user_rating IS NOT NULL',
  ).all(telegramId, getHistoryOwner(db, telegramId).accountKey) as { beer_id: number; user_rating: number }[];
  for (const r of profileRatings) {
    if (!out.has(r.beer_id)) out.set(r.beer_id, r.user_rating);
  }
  return out;
}

export function hasBeenDrunk(db: DB, telegramId: number, beerId: number): boolean {
  const row = db.prepare(
    'SELECT 1 FROM checkins WHERE telegram_id = ? AND account_key = ? AND beer_id = ? LIMIT 1',
  ).get(telegramId, getHistoryOwner(db, telegramId).accountKey, beerId);
  return !!row;
}

export function checkinExists(db: DB, telegramId: number, checkinId: string, accountKey?: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM checkins WHERE telegram_id = ? AND account_key = ? AND checkin_id = ? LIMIT 1')
    .get(telegramId, accountKey ?? getHistoryOwner(db, telegramId).accountKey, checkinId);
}

export function countCheckins(db: DB, telegramId: number, accountKey?: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM checkins WHERE telegram_id = ? AND account_key = ?')
    .get(telegramId, accountKey ?? getHistoryOwner(db, telegramId).accountKey) as { n: number };
  return row.n;
}

export function latestCheckinAt(db: DB, telegramId: number): string | null {
  const row = db
    .prepare('SELECT MAX(checkin_at) AS m FROM checkins WHERE telegram_id = ? AND account_key = ?')
    .get(telegramId, getHistoryOwner(db, telegramId).accountKey) as { m: string | null };
  return row.m;
}

// #587: межа, нижче якої порожня відповідь фіду законна. Вище неї порожньо бути не може —
// принаймні цей наш власний чекін мав би повернутися, — тож порожнеча там доводить зламану
// сесію, а не дно стрічки.
//
// Рев'ю PR #592 (P2): нечисловий `checkin_id` (наприклад, залишок битого імпорту) під
// `CAST(... AS INTEGER)` перетворюється на 0 — і 0 як мінімум тягне межу до нуля, через що
// `422 no_session` перестає спрацьовувати саме там, де мав би. `GLOB '[0-9]*'` виключає такі
// рядки з розгляду ще до MIN; WHERE, як і раніше, починається з рівності по telegram_id,
// тож індекс усе одно використовується.
//
// Рев'ю PR #592, друге коло (P1): `GLOB '[0-9]*'` вимагає лише, щоб рядок ПОЧИНАВСЯ з цифри,
// а не щоб він був цифрою цілком — `'5e2' GLOB '[0-9]*'` теж істина. Такий рядок і досі
// проходить у CAST (CAST('5e2' AS INTEGER) = 5) і тягне межу вниз до вигаданого числа, якого
// в БД насправді немає під цим id. Додатковий `NOT GLOB '*[^0-9]*'` відкидає будь-який
// символ поза цифрами де завгодно в рядку — лишається рівно чисто десятковий вигляд.
export function oldestCheckinId(db: DB, telegramId: number, accountKey?: string): number | null {
  const row = db
    .prepare(
      `SELECT MIN(CAST(checkin_id AS INTEGER)) AS m FROM checkins
        WHERE telegram_id = ? AND account_key = ? AND checkin_id GLOB '[0-9]*' AND checkin_id NOT GLOB '*[^0-9]*'`,
    )
    .get(telegramId, accountKey ?? getHistoryOwner(db, telegramId).accountKey) as { m: number | null };
  return row.m;
}

export function countDistinctBeers(db: DB, telegramId: number): number {
  const row = db
    .prepare('SELECT COUNT(DISTINCT beer_id) AS n FROM checkins WHERE telegram_id = ? AND account_key = ? AND beer_id IS NOT NULL')
    .get(telegramId, getHistoryOwner(db, telegramId).accountKey) as { n: number };
  return row.n;
}

export function drunkBeerIds(db: DB, telegramId: number): Set<number> {
  const rows = db.prepare(
    'SELECT DISTINCT beer_id FROM checkins WHERE telegram_id = ? AND account_key = ? AND beer_id IS NOT NULL',
  ).all(telegramId, getHistoryOwner(db, telegramId).accountKey) as { beer_id: number }[];
  return new Set(rows.map((r) => r.beer_id));
}
