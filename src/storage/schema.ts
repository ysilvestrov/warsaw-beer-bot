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

// #377 part B. The 29 rows whose product is self-evidently not a beer — read one by
// one off prod on 2026-08-15, not derived by a LIKE over review_note. A heuristic here
// would be the same unverified bulk write that produced the 157-row incident.
// wine / spritz / cocktail, merch, bundle / mystery box / multipack / gift set, kombucha.
export const V24_NOT_A_BEER_IDS: readonly number[] = [
  19, 20, 21, 91, 116, 117, 191, 12044, 12309, 25663, 30053,
  25708,
  25709, 25710, 25725, 25933, 25961, 26006, 26044, 26097, 26098, 26099, 26100,
  29486, 29487, 29488, 29489, 32178,
  33659,
];

// SQLite cannot alter a CHECK in place, so the class-set change forces a full table
// rebuild — which is also the only moment the legacy rows can be rewritten, because
// the new CHECK rejects 'wontfix' outright. Hence the rewrite lives in the copy's
// SELECT, not in a follow-up UPDATE.
//
// Two branches only (spec: "re-derive, do not translate"):
//   * the enumerated ids  -> not_a_beer, verdict kept (the product is the evidence)
//   * every other wontfix -> NULL, verdict voided, note preserved for audit
// plus the general rule that a row we could not ask about (outcome != 'not_found')
// carries no class at all — which the second CHECK then enforces forever.
//
// FK note: enrich_failures is a child table and nothing references it, so the rebuild
// is safe with `foreign_keys = ON` and needs no PRAGMA toggle (which would be a no-op
// inside migrate()'s transaction anyway).
export const V24_REBUILD_SQL = `
  CREATE TABLE enrich_failures_v24 (
    beer_id            INTEGER NOT NULL PRIMARY KEY
                       REFERENCES beers(id) ON DELETE CASCADE,
    brewery            TEXT NOT NULL,
    name               TEXT NOT NULL,
    search_url         TEXT NOT NULL,
    outcome            TEXT NOT NULL CHECK (outcome IN ('not_found','blocked')),
    candidates_count   INTEGER NOT NULL,
    candidates_summary TEXT NOT NULL,
    fail_count         INTEGER NOT NULL DEFAULT 1,
    last_at            TEXT NOT NULL,
    source_url         TEXT NOT NULL DEFAULT '',
    review_class       TEXT CHECK (review_class IN
                         ('parser_bug','matcher_bug','not_on_untappd','unidentifiable','not_a_beer')),
    review_note        TEXT,
    reviewed_at        TEXT,
    retired_at         TEXT,
    issue_number       INTEGER,
    CHECK (review_class IS NULL OR outcome = 'not_found')
  );

  INSERT INTO enrich_failures_v24
    (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
     fail_count, last_at, source_url, review_class, review_note, reviewed_at, retired_at, issue_number)
  SELECT beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
         fail_count, last_at, source_url,
         CASE
           WHEN outcome <> 'not_found' THEN NULL
           WHEN review_class = 'wontfix' AND beer_id IN (${V24_NOT_A_BEER_IDS.join(',')}) THEN 'not_a_beer'
           WHEN review_class = 'wontfix' THEN NULL
           ELSE review_class
         END,
         CASE
           WHEN outcome <> 'not_found' AND review_class IS NOT NULL
             THEN '#377: verdict voided (written with no evidence — Untappd never answered). Was: '
                  || COALESCE(review_note, '')
           WHEN review_class = 'wontfix' AND beer_id NOT IN (${V24_NOT_A_BEER_IDS.join(',')})
             THEN '#377: prior wontfix verdict voided (vocabulary rework); re-triage. Was: '
                  || COALESCE(review_note, '')
           ELSE review_note
         END,
         CASE
           WHEN outcome <> 'not_found' THEN NULL
           WHEN review_class = 'wontfix' AND beer_id NOT IN (${V24_NOT_A_BEER_IDS.join(',')}) THEN NULL
           ELSE reviewed_at
         END,
         retired_at,
         CASE
           WHEN outcome <> 'not_found' THEN NULL
           WHEN review_class = 'wontfix' AND beer_id NOT IN (${V24_NOT_A_BEER_IDS.join(',')}) THEN NULL
           ELSE issue_number
         END
    FROM enrich_failures;

  DROP TABLE enrich_failures;
  ALTER TABLE enrich_failures_v24 RENAME TO enrich_failures;
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
  {
    version: 24,
    // #377 part B: one meaning per class. Adds not_a_beer, renames wontfix ->
    // unidentifiable (no row carries the new name at migration time — every legacy
    // wontfix is either re-derived as not_a_beer or voided), and adds the constraint
    // that a verdict cannot exist on a row we could not ask about.
    sql: V24_REBUILD_SQL,
  },
  {
    version: 25,
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN unlocked_at TEXT;
    `,
  },
  {
    version: 26,
    // #379: opt-out for extension release announcements. Default 0 — existing token
    // holders receive announcements, and the message itself tells them how to stop.
    // Plain ADD COLUMN like `language` (v3) and `city` (v14) before it.
    sql: `
      ALTER TABLE user_profiles ADD COLUMN announce_opt_out INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 27,
    // #558: третій термінальний стан. `retired_at` стверджує «фікс розв'язав проблему» і
    // стережеться `sealRetiredFalsified`; тут твердження інше — «фікс приїхав, і реплей
    // довів, що ЦЕЙ рядок він не рятує». Окремі колонки саме тому, що змішування зробило б
    // сторожа сліпим. `unrescued_issue` — машиночитана причина (#508 виставив рахунок за
    // 250 рядків із причиною у вільному тексті). Пулів це не змінює: рядок лишається
    // в пулі зі своїм бекофом, ми відбираємо лише безкоштовне обнулення лічильника.
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN unrescued_at TEXT;
      ALTER TABLE enrich_failures ADD COLUMN unrescued_issue INTEGER;
    `,
  },
  {
    version: 28,
    // #576 (рев'ю PR #580): ре-арм спостережуваний лише за тим, що він обнуляє
    // `untappd_lookup_at`/`untappd_lookup_count`. Але рядок, щойно ре-армлений і ще не
    // перепробуваний, уже має нулі — і другий ре-арм по ньому не змінює в БД НІЧОГО. Тоді
    // адюдикація не бачить, що між пробою і застосуванням рядку дали новий шанс, і мовчки
    // його скасовує. Монотонний лічильник робить сам ФАКТ ре-арму спостережуваним незалежно
    // від того, що він там обнулив. Лічильник, а не таймстамп: два ре-арми в ту саму
    // мілісекунду таймстамп не розрізнив би, а це рівно той випадок, який ми ловимо.
    sql: `
      ALTER TABLE beers ADD COLUMN rearm_count INTEGER NOT NULL DEFAULT 0;
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
