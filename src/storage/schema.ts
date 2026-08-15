import type { DB } from './db';

// Exported so a test can exercise the EXACT statement migration 23 runs. Re-running the
// whole v23 entry to test it is impossible — its ALTER TABLE would fail with "duplicate
// column name" — and a re-typed copy in the test would silently drift from this one.
//
// Offsets are character-based (SQLite instr/substr on TEXT), and '→ #' is three
// characters, so +3 lands on the first digit; +4 would drop it and turn #347 into 47.
// No trimming is needed either way: CAST stops at the first non-digit, so the mangled
// "→ #405 (re-routed 2026-08-14 from #347)" still resolves to 405, and a note with no
// arrow casts to 0 and is excluded by the > 0 guard.
export const V23_BACKFILL_SQL = `
  UPDATE enrich_failures
     SET issue_number = CAST(substr(review_note, instr(review_note, '→ #') + 3) AS INTEGER)
   WHERE review_note LIKE '%→ #%'
     AND CAST(substr(review_note, instr(review_note, '→ #') + 3) AS INTEGER) > 0;
`;

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE beers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        untappd_id INTEGER UNIQUE,
        name TEXT NOT NULL,
        brewery TEXT NOT NULL,
        style TEXT,
        abv REAL,
        rating_global REAL,
        normalized_name TEXT NOT NULL,
        normalized_brewery TEXT NOT NULL
      );
      CREATE INDEX idx_beers_norm ON beers(normalized_brewery, normalized_name);

      CREATE TABLE pubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        address TEXT,
        lat REAL,
        lon REAL
      );

      CREATE TABLE tap_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pub_id INTEGER NOT NULL REFERENCES pubs(id),
        snapshot_at TEXT NOT NULL
      );
      CREATE INDEX idx_snapshot_pub_time ON tap_snapshots(pub_id, snapshot_at DESC);

      CREATE TABLE taps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES tap_snapshots(id) ON DELETE CASCADE,
        tap_number INTEGER,
        beer_ref TEXT NOT NULL,
        brewery_ref TEXT,
        abv REAL,
        ibu REAL,
        style TEXT,
        u_rating REAL
      );
      CREATE INDEX idx_taps_snapshot ON taps(snapshot_id);

      CREATE TABLE checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checkin_id TEXT NOT NULL,
        telegram_id INTEGER NOT NULL,
        beer_id INTEGER REFERENCES beers(id),
        user_rating REAL,
        checkin_at TEXT NOT NULL,
        venue TEXT,
        UNIQUE(telegram_id, checkin_id)
      );
      CREATE INDEX idx_checkins_user_beer ON checkins(telegram_id, beer_id);

      CREATE TABLE match_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ontap_ref TEXT NOT NULL UNIQUE,
        untappd_beer_id INTEGER REFERENCES beers(id),
        confidence REAL NOT NULL,
        reviewed_by_user INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE user_profiles (
        telegram_id INTEGER PRIMARY KEY,
        untappd_username TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE user_filters (
        telegram_id INTEGER PRIMARY KEY REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
        styles TEXT,
        min_rating REAL,
        abv_min REAL,
        abv_max REAL,
        default_route_n INTEGER
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE pub_distances (
        pub_id_a INTEGER NOT NULL REFERENCES pubs(id) ON DELETE CASCADE,
        pub_id_b INTEGER NOT NULL REFERENCES pubs(id) ON DELETE CASCADE,
        meters REAL NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('osrm', 'haversine')),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (pub_id_a, pub_id_b),
        CHECK (pub_id_a < pub_id_b)
      );
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE user_profiles ADD COLUMN language TEXT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE untappd_had (
        telegram_id INTEGER NOT NULL,
        beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (telegram_id, beer_id)
      );
      CREATE INDEX idx_untappd_had_telegram ON untappd_had(telegram_id);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE beers ADD COLUMN untappd_lookup_at TEXT;
      ALTER TABLE beers ADD COLUMN untappd_lookup_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE beers ADD COLUMN rating_refresh_at TEXT;
      ALTER TABLE beers ADD COLUMN rating_refresh_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 7,
    sql: `
      UPDATE beers SET untappd_lookup_at = NULL, untappd_lookup_count = 0
      WHERE untappd_id IS NULL;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE api_tokens (
        token_hash TEXT NOT NULL PRIMARY KEY,
        telegram_id INTEGER NOT NULL
                    REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_api_tokens_telegram ON api_tokens(telegram_id);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE extension_releases (
        version      TEXT NOT NULL PRIMARY KEY,
        sha256       TEXT NOT NULL,
        notes        TEXT NOT NULL,
        file_id      TEXT,
        published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attached_by  INTEGER
      );
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE enrich_failures (
        beer_id            INTEGER NOT NULL PRIMARY KEY
                           REFERENCES beers(id) ON DELETE CASCADE,
        brewery            TEXT NOT NULL,
        name               TEXT NOT NULL,
        search_url         TEXT NOT NULL,
        outcome            TEXT NOT NULL CHECK (outcome IN ('not_found','blocked')),
        candidates_count   INTEGER NOT NULL,
        candidates_summary TEXT NOT NULL,
        fail_count         INTEGER NOT NULL DEFAULT 1,
        last_at            TEXT NOT NULL
      );
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN review_class TEXT
        CHECK (review_class IN ('parser_bug','matcher_bug','not_on_untappd','wontfix'));
      ALTER TABLE enrich_failures ADD COLUMN review_note TEXT;
      ALTER TABLE enrich_failures ADD COLUMN reviewed_at TEXT;
    `,
  },
  {
    version: 13,
    sql: `
      CREATE TABLE checkin_sync_state (
        telegram_id    INTEGER PRIMARY KEY
                         REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
        deepest_max_id TEXT,
        complete       INTEGER NOT NULL DEFAULT 0,
        updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE pubs ADD COLUMN city TEXT NOT NULL DEFAULT 'warszawa';
      ALTER TABLE user_profiles ADD COLUMN city TEXT;
      CREATE INDEX idx_pubs_city ON pubs(city);
    `,
  },
  {
    version: 15,
    sql: `
      CREATE TABLE job_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 16,
    sql: `
      ALTER TABLE checkin_sync_state ADD COLUMN profile_total INTEGER;
    `,
  },
  {
    version: 17,
    sql: `
      CREATE TABLE api_usage (
        date            TEXT PRIMARY KEY,
        anon_requests   INTEGER NOT NULL DEFAULT 0,
        authed_requests INTEGER NOT NULL DEFAULT 0,
        beers           INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 18,
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN retired_at TEXT;
    `,
  },
  {
    version: 19,
    sql: `
      ALTER TABLE beers ADD COLUMN google_tried_at TEXT;
      CREATE TABLE google_quota (
        day   TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 20,
    sql: `
      ALTER TABLE google_quota RENAME TO web_search_quota;
      ALTER TABLE beers RENAME COLUMN google_tried_at TO web_tried_at;
    `,
  },
  {
    version: 21,
    sql: `
      ALTER TABLE match_links ADD COLUMN merged_at TEXT;
    `,
  },
  {
    version: 22,
    // #384: provenance for beers.untappd_id, so a shop-published bid may override a
    // machine-derived link but never a curated or check-in-sourced one.
    // The backfill is load-bearing, not cosmetic: without it every existing pin
    // reads as NULL = machine-derived = overridable, silently undoing #343.
    // match_links.untappd_beer_id is a LOCAL beers.id, not an Untappd bid.
    sql: `
      ALTER TABLE beers ADD COLUMN untappd_id_source TEXT
        CHECK (untappd_id_source IN ('search','bid','curated','checkin'));
      UPDATE beers SET untappd_id_source = 'curated'
       WHERE id IN (SELECT untappd_beer_id FROM match_links WHERE reviewed_by_user = 1);
    `,
  },
  {
    version: 23,
    // #408: the row -> issue link existed only as a free-text suffix appended by
    // orphan-triage ("... -> #123"), which nothing could query and which the re-routing
    // notes written on 2026-08-14 already broke ("-> #405 (re-routed ...)"). Without the
    // column the saturation guard cannot count rows per issue, and neither #408 nor #381
    // can be audited after the fact — "which rows went to this issue" is not answerable
    // today. Backfill is in V23_BACKFILL_SQL so a test can exercise the exact statement.
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN issue_number INTEGER;
      ${V23_BACKFILL_SQL}
    `,
  },
];

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);`);
  const current =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }).v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    });
    tx();
  }
}
