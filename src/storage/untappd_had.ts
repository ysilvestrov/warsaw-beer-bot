import type { DB } from './db';
import { drunkBeerIds } from './checkins';

export function markHad(
  db: DB,
  telegramId: number,
  beerId: number,
  at: string,
): void {
  db.prepare(
    `INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id, beer_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at`,
  ).run(telegramId, beerId, at);
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
