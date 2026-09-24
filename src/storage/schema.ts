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
  {
    version: 29,
    // #587: скаляр `deepest_max_id` брався як мінімум із двох обходів, не суцільних між
    // собою, і цим СТВЕРДЖУВАВ покриття, якого ніхто не встановлював — 41 чекін лишився
    // недосяжним обома фазами. Тут покриття стає тим, що сторінка фіду доводить сама:
    // діапазоном [найстарший_на_сторінці, курсор]. Об'єднання таких діапазонів збрехати
    // не може, а обірваний прогін просто перестає їх додавати.
    //
    // Без сиду (рев'ю PR #592, P1). Перша версія сидувала [MIN, MAX] для кожного, у кого
    // `COUNT(*) >= profile_total` — але рівність лічильників не доводить суцільність:
    // користувач, що тримає застарілий рядок (чекін, видалений на Untappd, лишився в нас),
    // може задовольнити лічильник, поки ІНШИЙ id всередині того самого діапазону насправді
    // відсутній. Сид тоді покрив би саме ту діру, яку застарілий рядок маскував, і обхід
    // перестрибував би її назавжди — рівно той дефект, проти якого ця гілка. Доказу
    // суцільності для історичних рядків нема, тож міграція нічого не стверджує: перший
    // живий обхід кожного користувача проходить його історію сам і саме цим заодно
    // знаходить будь-яку діру, яку сид замаскував би.
    sql: `
      CREATE TABLE IF NOT EXISTS checkin_coverage (
        telegram_id INTEGER NOT NULL
                      REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
        from_id     INTEGER NOT NULL,
        to_id       INTEGER NOT NULL,
        PRIMARY KEY (telegram_id, from_id)
      );
    `,
  },
  {
    version: 30,
    // MCP-канал (`POST /mcp`). §3.16 оголошує `anon_requests`/`authed_requests` трафіком
    // РОЗШИРЕННЯ, і щоденний дайджест друкує з них рядок «Розширення /match». Якби MCP
    // писав у ті самі лічильники, рядок і далі стверджував би факт про розширення,
    // рахуючи розширення ПЛЮС агентів, — і виявити підміну було б нізвідки, бо число
    // просто виросло б. Окремі колонки лишають історичні значення тим, чим вони були.
    // Проста ALTER TABLE ADD COLUMN: перебудова тут не потрібна, бо жодного CHECK
    // ця таблиця не має.
    sql: `
      ALTER TABLE api_usage ADD COLUMN mcp_requests INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE api_usage ADD COLUMN mcp_beers INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 31,
    // #616: «рейтинг звірено з Untappd у момент T». Без бекфілу: доказу звірки немає ні в кого —
    // стара джоба рейтингів не штампувала, а синк чекінів до #617 рейтинги стирав.
    // rating_refresh_* відтепер — бекоф лише для bid, якого Algolia не знає; значення старої
    // HTML-джоби («на сторінці немає рейтингу», транзієнт) цього не стверджують, тож скидаються.
    // Рейтинг 0 за правилом межі парсерів означає «менше 10 оцінок» = немає рейтингу; без цього
    // UPDATE нулі на bid, яких Algolia не знає, лишилися б назавжди (гідратор їх не звіряє).
    sql: `
      ALTER TABLE beers ADD COLUMN rating_checked_at TEXT;
      UPDATE beers SET rating_refresh_at = NULL, rating_refresh_count = 0
        WHERE rating_refresh_at IS NOT NULL OR rating_refresh_count <> 0;
      UPDATE beers SET rating_global = NULL WHERE rating_global = 0;
    `,
  },
  {
    version: 32,
    // #614: злиття сироти в канонічний рядок видаляє єдиний запис того, що пара «броварня + назва»
    // з картки крамниці — це саме це пиво. Без нього `/match` на кожне завантаження сторінки знову
    // не впізнає картку, розширення знову шукає в сесії Untappd і сервер знову зливає нову сироту.
    // Аліас зберігає сиру пару (аудит і рецепт скасування) і ключ — cardText броварні й назви картки
    // (#614): лише представлення тексту, без нормалізатора кандидатів, який зводить різні пива (#636).
    // abv_key — cardAbv картки: крамниця друкує однаковий текст для 0%- і алкогольної версії.
    // Без бекфілу: сирота видаляється при злитті, тож відновлювати пару нема з чого — таблиця
    // заповнюється першим же злиттям (як merged_at, #366).
    // IF NOT EXISTS — бо тести відкату в schema.test.ts перезапускають усі міграції від v22.
    sql: `
      CREATE TABLE IF NOT EXISTS beer_aliases (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        beer_id      INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
        brewery      TEXT NOT NULL,
        name         TEXT NOT NULL,
        brewery_text TEXT NOT NULL,
        name_text    TEXT NOT NULL,
        abv_key      TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        UNIQUE (brewery_text, name_text, abv_key)
      );
      CREATE INDEX IF NOT EXISTS idx_beer_aliases_beer ON beer_aliases(beer_id);
    `,
  },
  {
    version: 33,
    // #632: `ontap_ref` — лише текст назви крана. Один рядок лінку ділили крани різних броварень з однаковою назвою
    // («Hefeweizen» Friedenfelser і Rittmayer): паб, де матчер влучав, переписував лінк і стирав штамп злиття (#366),
    // а паб, де промахувався, щоцикла створював і зливав сироту заново; показ пабу брав пиво останнього паба циклу.
    // Ключ — пара точного тексту броварні крана (NULL → '') і назви крана. Наявні лінки розкладаються за броварнями
    // зі збережених знімків:
    // - одна броварня → пара; пін — лише якщо назва є в знімку всередині вікна збереження (останній знімок − 13 днів
    //   — на день менше SNAPSHOT_RETENTION_DAYS (за замовчуванням 14), бо cleanup-old-snapshots ріже за ЧАС ВЛАСНОГО
    //   ЗАПУСКУ, а не за час останнього знімка, тож перші години вікна вже можуть бути видалені); штамп — лише якщо
    //   merged_at всередині цього вікна. Поза вікном cleanup-old-snapshots лишає тільки останній знімок кожного паба,
    //   тож знімок броварні, що дала злиття, міг зникнути, а стара броварня сплячого паба — лишитися єдиною (рев'ю Task 1).
    // - кілька броварень → копія на кожну пару без піна й штампа: котрій броварні належить ціль, невідомо, тож
    //   показ до інжесту не змінюється, а інжест перераховує; confidence копії — не вище 0.99, бо копія нічого не
    //   стверджує, і пізніше злиття її сироти мусить лише переспрямувати лінк, а не штампувати його (mergeIntoCanonical
    //   штампує лише WHERE confidence >= 1.0).
    // - жодної → видалення: ні показ, ні #486 такий лінк не читають.
    // Dry-run справжнім кодом на байтовій копії прод-БД 2026-09-15: 5411 → 1685 лінків, 7 пінів, 20 штампів; показ
    // 1692 кранів побайтно без змін.
    // Перебудова, а не ALTER: SQLite не змінює UNIQUE на місці. Повторний прогін (тести відкату в schema.test.ts)
    // безпечний лише над таблицею, де на назву один рядок: SELECT читає тільки ontap_ref, а дві броварні однієї
    // назви дали б дублікати пари.
    sql: `
      CREATE TABLE match_links_v33 (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ontap_ref        TEXT NOT NULL,
        brewery_ref      TEXT NOT NULL DEFAULT '',
        untappd_beer_id  INTEGER REFERENCES beers(id),
        confidence       REAL NOT NULL,
        reviewed_by_user INTEGER NOT NULL DEFAULT 0,
        merged_at        TEXT,
        UNIQUE (ontap_ref, brewery_ref)
      );
      INSERT INTO match_links_v33 (ontap_ref, brewery_ref, untappd_beer_id, confidence, reviewed_by_user, merged_at)
        WITH pairs AS (
               SELECT DISTINCT beer_ref, coalesce(brewery_ref, '') AS brewery_ref FROM taps
             ),
             counts AS (
               SELECT beer_ref, COUNT(*) AS n FROM pairs GROUP BY beer_ref
             ),
             retained AS (
               SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(snapshot_at), '-13 days') AS since FROM tap_snapshots
             ),
             recent AS (
               SELECT DISTINCT t.beer_ref
                 FROM taps t JOIN tap_snapshots s ON s.id = t.snapshot_id CROSS JOIN retained r
                WHERE s.snapshot_at >= r.since
             )
        SELECT ml.ontap_ref, p.brewery_ref, ml.untappd_beer_id,
               CASE WHEN c.n = 1 THEN ml.confidence ELSE min(ml.confidence, 0.99) END,
               CASE WHEN c.n = 1 AND rc.beer_ref IS NOT NULL THEN ml.reviewed_by_user ELSE 0 END,
               CASE WHEN c.n = 1 AND ml.merged_at >= r.since THEN ml.merged_at ELSE NULL END
          FROM match_links ml
          JOIN pairs p ON p.beer_ref = ml.ontap_ref
          JOIN counts c ON c.beer_ref = ml.ontap_ref
          CROSS JOIN retained r
          LEFT JOIN recent rc ON rc.beer_ref = ml.ontap_ref;
      DROP TABLE match_links;
      ALTER TABLE match_links_v33 RENAME TO match_links;
    `,
  },
  {
    version: 34,
    // #696: historical shop-card repair deletes the orphan and may later outlive the
    // canonical row too. Keep both local IDs as snapshots, not cascading FKs.
    sql: `
      CREATE TABLE IF NOT EXISTS legacy_card_repairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orphan_beer_id INTEGER NOT NULL UNIQUE,
        issue_number INTEGER NOT NULL CHECK (issue_number > 0),
        card_brewery TEXT NOT NULL CHECK (length(trim(card_brewery)) > 0),
        card_name TEXT NOT NULL CHECK (length(trim(card_name)) > 0),
        card_abv REAL,
        failure_source_url TEXT NOT NULL,
        target_bid INTEGER NOT NULL CHECK (target_bid > 0),
        canonical_beer_id INTEGER NOT NULL,
        evidence_url TEXT NOT NULL CHECK (length(trim(evidence_url)) > 0),
        operator TEXT NOT NULL CHECK (length(trim(operator)) > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
        overwrite_abv INTEGER NOT NULL CHECK (overwrite_abv IN (0, 1)),
        prior_canonical_abv REAL,
        final_canonical_abv REAL,
        applied_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_legacy_card_repairs_issue ON legacy_card_repairs(issue_number);
    `,
  },
  {
    version: 35,
    // #695: one active decision per historical row and exact shop-card key.
    // Historical beer IDs must survive later deletion, so there is no cascading FK.
    sql: `
      CREATE TABLE IF NOT EXISTS legacy_orphan_dispositions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        beer_id INTEGER NOT NULL CHECK (beer_id > 0),
        issue_number INTEGER NOT NULL CHECK (issue_number > 0),
        card_brewery TEXT NOT NULL CHECK (length(trim(card_brewery)) > 0),
        card_name TEXT NOT NULL CHECK (length(trim(card_name)) > 0),
        card_abv REAL CHECK (card_abv IS NULL OR card_abv BETWEEN 0 AND 100),
        brewery_text TEXT NOT NULL CHECK (length(brewery_text) > 0),
        name_text TEXT NOT NULL CHECK (length(name_text) > 0),
        abv_key TEXT NOT NULL,
        failure_source_url TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
        evidence_url TEXT NOT NULL CHECK (length(trim(evidence_url)) > 0),
        operator TEXT NOT NULL CHECK (length(trim(operator)) > 0),
        inactive_at TEXT NOT NULL,
        reopened_at TEXT,
        reopening_reason TEXT,
        reopening_evidence_url TEXT,
        reopening_operator TEXT,
        CHECK ((reopened_at IS NULL AND reopening_reason IS NULL
                AND reopening_evidence_url IS NULL AND reopening_operator IS NULL)
            OR (reopened_at IS NOT NULL AND reopening_reason IS NOT NULL
                AND reopening_evidence_url IS NOT NULL AND reopening_operator IS NOT NULL
                AND length(trim(reopening_reason)) > 0
                AND length(trim(reopening_evidence_url)) > 0
                AND length(trim(reopening_operator)) > 0))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_orphan_active_beer
        ON legacy_orphan_dispositions(beer_id) WHERE reopened_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_orphan_active_card
        ON legacy_orphan_dispositions(brewery_text, name_text, abv_key) WHERE reopened_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_legacy_orphan_dispositions_issue ON legacy_orphan_dispositions(issue_number);
    `,
  },
  {
    version: 36,
    // #697: only a canary-backed, applied positive replay can authorize issue-close rearm.
    // No backfill: old closed issues carry no per-row proof.
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN rescued_issue INTEGER;
      ALTER TABLE enrich_failures ADD COLUMN rescued_at TEXT;
      ALTER TABLE enrich_failures ADD COLUMN rescued_bid INTEGER;
      ALTER TABLE enrich_failures ADD COLUMN rescued_brewery TEXT;
      ALTER TABLE enrich_failures ADD COLUMN rescued_name TEXT;
      ALTER TABLE enrich_failures ADD COLUMN rescued_abv REAL;
      ALTER TABLE enrich_failures ADD COLUMN rescued_lookup_count INTEGER;
      ALTER TABLE enrich_failures ADD COLUMN rescued_lookup_at TEXT;
      ALTER TABLE enrich_failures ADD COLUMN rescued_rearm_count INTEGER;
      ALTER TABLE enrich_failures ADD COLUMN rescued_probed_at TEXT;
      CREATE TRIGGER clear_rescue_on_retriage
      AFTER UPDATE OF issue_number, review_class ON enrich_failures
      WHEN NEW.issue_number IS NOT OLD.issue_number OR NEW.review_class IS NOT OLD.review_class
      BEGIN
        UPDATE enrich_failures SET rescued_issue = NULL WHERE beer_id = NEW.beer_id;
      END;
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
