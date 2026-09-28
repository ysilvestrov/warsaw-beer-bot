import type { DB } from './db';
import { ensureProfile, setUntappdUsername } from './user_profiles';
import { markHad } from './untappd_had';
import { mergeCheckin } from './checkins';

// Three independent owners plus one canonical observation that must win its
// own collision. Literal ratings make cross-account leakage visible.
export function seedMergeHistory(db: DB, source: number, target: number): void {
  ensureProfile(db, 1);
  ensureProfile(db, 2);
  setUntappdUsername(db, 1, 'a');
  setUntappdUsername(db, 2, 'a');
  markHad(db, 1, source, '2026-09-02T00:00:00Z', 4, 'a');
  markHad(db, 1, source, '2026-09-02T00:00:00Z', 0, 'b');
  markHad(db, 2, source, '2026-09-02T00:00:00Z', 2, 'a');
  markHad(db, 1, target, '2026-09-01T00:00:00Z', 3, 'a');
  mergeCheckin(db, { telegram_id: 1, account_key: 'b', beer_id: source, checkin_id: '123',
    user_rating: 1, checkin_at: '2026-09-01T00:00:00Z', venue: null });
}

export function mergedHistoryRows(db: DB): unknown[] {
  return db.prepare(`SELECT telegram_id, account_key, beer_id, last_seen_at, user_rating
    FROM untappd_had ORDER BY telegram_id, account_key, beer_id`).all();
}
