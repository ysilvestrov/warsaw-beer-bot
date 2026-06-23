import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import type { DB } from '../storage/db';
import { backfillCheckinAt } from './backfill-checkin-at';

const log = pino({ level: 'silent' });

// Insert a checkin row with a raw (un-normalized) checkin_at, bypassing
// mergeCheckin's normalization — simulates legacy rows written before the fix.
function insertRaw(db: DB, id: string, checkinAt: string, telegramId = 1): void {
  db.prepare(
    'INSERT INTO checkins (checkin_id, telegram_id, beer_id, user_rating, checkin_at, venue) VALUES (?, ?, NULL, NULL, ?, NULL)',
  ).run(id, telegramId, checkinAt);
}

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('backfillCheckinAt', () => {
  it('rewrites legacy RFC-2822 rows to canonical UTC and counts them', () => {
    const db = freshDb();
    insertRaw(db, 'rfc1', 'Tue, 05 May 2026 21:40:37 +0000');
    insertRaw(db, 'rfc2', 'Wed, 29 Apr 2026 18:53:59 +0000');
    insertRaw(db, 'iso', '2016-04-15 19:06:47'); // already canonical — must be untouched

    const { updated } = backfillCheckinAt(db, log);
    expect(updated).toBe(2);

    const rows = db
      .prepare('SELECT checkin_id, checkin_at FROM checkins ORDER BY checkin_id')
      .all() as Array<{ checkin_id: string; checkin_at: string }>;
    expect(rows).toEqual([
      { checkin_id: 'iso', checkin_at: '2016-04-15 19:06:47' },
      { checkin_id: 'rfc1', checkin_at: '2026-05-05 21:40:37' },
      { checkin_id: 'rfc2', checkin_at: '2026-04-29 18:53:59' },
    ]);
  });

  it('is idempotent — a second run updates nothing', () => {
    const db = freshDb();
    insertRaw(db, 'rfc1', 'Tue, 05 May 2026 21:40:37 +0000');
    expect(backfillCheckinAt(db, log).updated).toBe(1);
    expect(backfillCheckinAt(db, log).updated).toBe(0);
  });

  it('leaves a clean ISO-only table completely untouched', () => {
    const db = freshDb();
    insertRaw(db, 'a', '2024-05-05 20:00:00');
    insertRaw(db, 'b', '2023-01-01 10:00:00');
    expect(backfillCheckinAt(db, log).updated).toBe(0);
  });
});
