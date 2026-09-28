import { openDb } from './db';
import { V41_ACCOUNT_HISTORY_SQL } from './schema';
import { HISTORY_V40_DDL } from './history-v40.testing';

test('v41 assigns confirmed existing history without losing rows, coverage, ratings or allocated IDs', () => {
  const db = openDb(':memory:');
  db.exec(`
    CREATE TABLE user_profiles(telegram_id INTEGER PRIMARY KEY, untappd_username TEXT,
      untappd_link_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE beers(id INTEGER PRIMARY KEY);
    ${HISTORY_V40_DDL}
    INSERT INTO user_profiles VALUES(1, 'Old_Name', 3), (2, NULL, 0);
    INSERT INTO beers VALUES(7);
    INSERT INTO checkins VALUES(42, '123', 1, 7, 0, '2026-09-01T00:00:00Z', 'Pub');
    INSERT INTO checkins VALUES(99, '456', 2, NULL, NULL, '2026-09-02T00:00:00Z', NULL);
    INSERT INTO checkins VALUES(150, 'deleted', 1, 7, NULL, '2026-09-03T00:00:00Z', NULL);
    DELETE FROM checkins WHERE id=150;
    INSERT INTO untappd_had VALUES(1, 7, '2026-09-03T00:00:00Z', 0);
    INSERT INTO checkin_coverage VALUES(1, 100, 200);
    INSERT INTO checkin_sync_state VALUES(1, '100', 1, '2026-09-03T00:00:00Z', 30);
  `);
  db.transaction(() => db.exec(V41_ACCOUNT_HISTORY_SQL))();
  expect(db.prepare('SELECT * FROM checkins ORDER BY id').all()).toEqual([
    { id: 42, checkin_id: '123', telegram_id: 1, account_key: 'old_name', beer_id: 7,
      user_rating: 0, checkin_at: '2026-09-01T00:00:00Z', venue: 'Pub' },
    { id: 99, checkin_id: '456', telegram_id: 2, account_key: '', beer_id: null,
      user_rating: null, checkin_at: '2026-09-02T00:00:00Z', venue: null },
  ]);
  expect(db.prepare('SELECT * FROM untappd_had').all()).toEqual([
    { telegram_id: 1, account_key: 'old_name', beer_id: 7, last_seen_at: '2026-09-03T00:00:00Z', user_rating: 0 },
  ]);
  expect(db.prepare('SELECT * FROM checkin_coverage').all()).toEqual([
    { telegram_id: 1, account_key: 'old_name', from_id: 100, to_id: 200 },
  ]);
  expect(db.prepare('SELECT * FROM checkin_sync_state').all()).toEqual([
    { telegram_id: 1, account_key: 'old_name', deepest_max_id: '100', complete: 1,
      updated_at: '2026-09-03T00:00:00Z', profile_total: 30 },
  ]);
  expect(db.prepare('SELECT telegram_id, legacy_sync_revision FROM user_profiles ORDER BY telegram_id').all())
    .toEqual([{ telegram_id: 1, legacy_sync_revision: 3 }, { telegram_id: 2, legacy_sync_revision: null }]);
  expect(db.prepare("INSERT INTO checkins(checkin_id, telegram_id, checkin_at) VALUES('new', 2, '2026-09-04')")
    .run().lastInsertRowid).toBe(151);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(() => db.prepare("INSERT INTO untappd_had VALUES(1, 'old_name', 7, 'x', 6)").run()).toThrow(/CHECK/);
  db.close();
});
