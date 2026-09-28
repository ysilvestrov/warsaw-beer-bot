import type { DB } from './db';
import { getHistoryOwner } from './history-owner';
import { drunkBeerIds } from './checkins';

// The caller holds the catalog-mutation transaction and deletes the source
// only after this copy. Canonical ratings take precedence within each owner.
export function mergeHadBeerReferences(db: DB, fromBeerId: number, toBeerId: number): void {
  db.prepare(`INSERT INTO untappd_had(telegram_id, account_key, beer_id, last_seen_at, user_rating)
    SELECT telegram_id, account_key, ?, last_seen_at, user_rating FROM untappd_had WHERE beer_id = ?
    ON CONFLICT(telegram_id, account_key, beer_id) DO UPDATE SET
      last_seen_at = MAX(untappd_had.last_seen_at, excluded.last_seen_at),
      user_rating = COALESCE(untappd_had.user_rating, excluded.user_rating)`)
    .run(toBeerId, fromBeerId);
}

export function markHad(
  db: DB,
  telegramId: number,
  beerId: number,
  at: string,
  userRating?: number | null,
  accountKey?: string,
): void {
  const rating = typeof userRating === 'number' && Number.isFinite(userRating)
    && userRating >= 0 && userRating <= 5 ? userRating : null;
  db.prepare(
    `INSERT INTO untappd_had (telegram_id, account_key, beer_id, last_seen_at, user_rating)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id, account_key, beer_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       user_rating = COALESCE(excluded.user_rating, untappd_had.user_rating)`,
  ).run(telegramId, accountKey ?? getHistoryOwner(db, telegramId).accountKey, beerId, at, rating);
}

export function hadBeerIds(db: DB, telegramId: number): Set<number> {
  const rows = db
    .prepare('SELECT beer_id FROM untappd_had WHERE telegram_id = ? AND account_key = ?')
    .all(telegramId, getHistoryOwner(db, telegramId).accountKey) as { beer_id: number }[];
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
     WHERE h.telegram_id = ? AND h.account_key = ? AND NOT EXISTS (
       SELECT 1 FROM checkins c WHERE c.telegram_id = h.telegram_id AND c.account_key = h.account_key AND c.beer_id = h.beer_id
     )`,
  ).get(telegramId, getHistoryOwner(db, telegramId).accountKey) as { n: number };
  return row.n;
}
