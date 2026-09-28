import type { DB } from './db';
import { drunkBeerIds } from './checkins';

export function markHad(
  db: DB,
  telegramId: number,
  beerId: number,
  at: string,
  userRating?: number | null,
): void {
  const rating = typeof userRating === 'number' && Number.isFinite(userRating)
    && userRating >= 0 && userRating <= 5 ? userRating : null;
  db.prepare(
    `INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at, user_rating)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id, beer_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       user_rating = COALESCE(excluded.user_rating, untappd_had.user_rating)`,
  ).run(telegramId, beerId, at, rating);
}

export function hadBeerIds(db: DB, telegramId: number): Set<number> {
  const rows = db
    .prepare('SELECT beer_id FROM untappd_had WHERE telegram_id = ?')
    .all(telegramId) as { beer_id: number }[];
  return new Set(rows.map((r) => r.beer_id));
}

export function triedBeerIds(db: DB, telegramId: number): Set<number> {
  const out = drunkBeerIds(db, telegramId);
  for (const id of hadBeerIds(db, telegramId)) out.add(id);
  return out;
}

// Counts beers, not missing check-ins. last_seen_at cannot date consumption.
export function countHadWithoutCheckins(db: DB, telegramId: number): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM untappd_had h
     WHERE h.telegram_id = ? AND NOT EXISTS (
       SELECT 1 FROM checkins c WHERE c.telegram_id = h.telegram_id AND c.beer_id = h.beer_id
     )`,
  ).get(telegramId) as { n: number };
  return row.n;
}
