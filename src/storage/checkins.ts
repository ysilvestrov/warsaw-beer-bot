import type { DB } from './db';

export interface CheckinInput {
  checkin_id: string;
  telegram_id: number;
  beer_id: number | null;
  user_rating: number | null;
  checkin_at: string;
  venue: string | null;
}

export interface CheckinRow extends CheckinInput { id: number; }

export function mergeCheckin(db: DB, c: CheckinInput): void {
  db.prepare(
    `INSERT INTO checkins (checkin_id, telegram_id, beer_id, user_rating, checkin_at, venue)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id, checkin_id) DO UPDATE SET
       beer_id = excluded.beer_id,
       user_rating = excluded.user_rating,
       checkin_at = excluded.checkin_at,
       venue = excluded.venue`,
  ).run(c.checkin_id, c.telegram_id, c.beer_id, c.user_rating, c.checkin_at, c.venue);
}

export function checkinsForUser(db: DB, telegramId: number): CheckinRow[] {
  return db.prepare('SELECT * FROM checkins WHERE telegram_id = ? ORDER BY checkin_at DESC')
    .all(telegramId) as CheckinRow[];
}

export function hasBeenDrunk(db: DB, telegramId: number, beerId: number): boolean {
  const row = db.prepare(
    'SELECT 1 FROM checkins WHERE telegram_id = ? AND beer_id = ? LIMIT 1',
  ).get(telegramId, beerId);
  return !!row;
}

export function drunkBeerIds(db: DB, telegramId: number): Set<number> {
  const rows = db.prepare(
    'SELECT DISTINCT beer_id FROM checkins WHERE telegram_id = ? AND beer_id IS NOT NULL',
  ).all(telegramId) as { beer_id: number }[];
  return new Set(rows.map((r) => r.beer_id));
}
