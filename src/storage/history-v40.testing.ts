import type { DB } from './db';

// Literal historical schema for migration tests, not a copy of the migration.
export const HISTORY_V40_DDL = `
CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT, checkin_id TEXT NOT NULL,
  telegram_id INTEGER NOT NULL, beer_id INTEGER REFERENCES beers(id),
  user_rating REAL, checkin_at TEXT NOT NULL, venue TEXT,
  UNIQUE(telegram_id, checkin_id)
);
CREATE INDEX idx_checkins_user_beer ON checkins(telegram_id, beer_id);
CREATE TABLE untappd_had (
  telegram_id INTEGER NOT NULL, beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL, user_rating REAL CHECK(user_rating IS NULL OR user_rating BETWEEN 0 AND 5),
  PRIMARY KEY(telegram_id, beer_id)
);
CREATE INDEX idx_untappd_had_telegram ON untappd_had(telegram_id);
CREATE TABLE checkin_coverage (
  telegram_id INTEGER NOT NULL REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, PRIMARY KEY(telegram_id, from_id)
);
CREATE TABLE checkin_sync_state (
  telegram_id INTEGER PRIMARY KEY REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
  deepest_max_id TEXT, complete INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, profile_total INTEGER
);
`;

// Older migration tests rewind a fully migrated fixture. Preserve their rows
// while removing the later history schema as well as its recorded version.
export function restoreV40History(db: DB): void {
  db.exec(`
    CREATE TEMP TABLE saved_checkins AS SELECT id, checkin_id, telegram_id, beer_id, user_rating, checkin_at, venue FROM checkins;
    CREATE TEMP TABLE saved_had AS SELECT telegram_id, beer_id, last_seen_at, user_rating FROM untappd_had;
    CREATE TEMP TABLE saved_coverage AS SELECT telegram_id, from_id, to_id FROM checkin_coverage;
    CREATE TEMP TABLE saved_sync AS SELECT telegram_id, deepest_max_id, complete, updated_at, profile_total FROM checkin_sync_state;
    DROP TABLE checkins; DROP TABLE untappd_had; DROP TABLE checkin_coverage; DROP TABLE checkin_sync_state;
    ${HISTORY_V40_DDL}
    INSERT INTO checkins SELECT * FROM saved_checkins;
    INSERT INTO untappd_had SELECT * FROM saved_had;
    INSERT INTO checkin_coverage SELECT * FROM saved_coverage;
    INSERT INTO checkin_sync_state SELECT * FROM saved_sync;
    DROP TABLE saved_checkins; DROP TABLE saved_had; DROP TABLE saved_coverage; DROP TABLE saved_sync;
    ALTER TABLE user_profiles DROP COLUMN legacy_sync_revision;
    DELETE FROM schema_version WHERE version >= 41;
  `);
}
