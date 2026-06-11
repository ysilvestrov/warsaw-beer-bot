import { openDb } from './db';
import { migrate } from './schema';

describe('schema migrations', () => {
  it('creates all tables in an empty db', () => {
    const db = openDb(':memory:');
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'beers', 'pubs', 'tap_snapshots', 'taps', 'checkins',
        'match_links', 'user_profiles', 'user_filters', 'pub_distances',
        'schema_version', 'api_tokens',
      ]),
    );
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it('migration v3 adds user_profiles.language column', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .prepare("PRAGMA table_info(user_profiles)")
      .all() as { name: string; type: string; dflt_value: unknown }[];
    const lang = cols.find((c) => c.name === 'language');
    expect(lang).toBeDefined();
    expect(lang?.type).toBe('TEXT');
    expect(lang?.dflt_value).toBeNull();
  });

  test('migration v4 creates untappd_had table', () => {
    const db = openDb(':memory:');
    migrate(db);
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='untappd_had'",
      )
      .get();
    expect(row).toEqual({ name: 'untappd_had' });
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_untappd_had_telegram'",
      )
      .get();
    expect(idx).toEqual({ name: 'idx_untappd_had_telegram' });
  });

  test('migration v5 adds beers.untappd_lookup_at + untappd_lookup_count columns', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .prepare('PRAGMA table_info(beers)')
      .all() as { name: string; type: string; notnull: number; dflt_value: unknown }[];

    const lookupAt = cols.find((c) => c.name === 'untappd_lookup_at');
    expect(lookupAt).toBeDefined();
    expect(lookupAt?.type).toBe('TEXT');
    expect(lookupAt?.notnull).toBe(0);

    const lookupCount = cols.find((c) => c.name === 'untappd_lookup_count');
    expect(lookupCount).toBeDefined();
    expect(lookupCount?.type).toBe('INTEGER');
    expect(lookupCount?.notnull).toBe(1);
    expect(String(lookupCount?.dflt_value)).toBe('0');
  });

  test('migration v6 adds beers.rating_refresh_at + rating_refresh_count columns', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .prepare('PRAGMA table_info(beers)')
      .all() as { name: string; type: string; notnull: number; dflt_value: unknown }[];

    const refreshAt = cols.find((c) => c.name === 'rating_refresh_at');
    expect(refreshAt).toBeDefined();
    expect(refreshAt?.type).toBe('TEXT');
    expect(refreshAt?.notnull).toBe(0);

    const refreshCount = cols.find((c) => c.name === 'rating_refresh_count');
    expect(refreshCount).toBeDefined();
    expect(refreshCount?.type).toBe('INTEGER');
    expect(refreshCount?.notnull).toBe(1);
    expect(String(refreshCount?.dflt_value)).toBe('0');
  });

  it('migration v7 is registered and resets only orphan lookup backoff', () => {
    const db = openDb(':memory:');
    migrate(db);

    // (a) v7 is registered — this is the fail-first hook (maxV is 6 before v7).
    const maxV = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(maxV).toBeGreaterThanOrEqual(7);

    // (b) the v7 statement: orphans (untappd_id NULL) get backoff cleared,
    //     matched beers (untappd_id set) are left untouched.
    db.prepare(
      `INSERT INTO beers (name, brewery, normalized_name, normalized_brewery,
         untappd_id, untappd_lookup_at, untappd_lookup_count)
       VALUES ('Wocky Talky', 'JBW Brewery', 'wocky talky', 'jbw',
         NULL, '2026-05-31T21:30:08.061Z', 3)`,
    ).run();
    db.prepare(
      `INSERT INTO beers (name, brewery, normalized_name, normalized_brewery,
         untappd_id, untappd_lookup_at, untappd_lookup_count)
       VALUES ('Atak Chmielu', 'Pinta', 'atak chmielu', 'pinta',
         12345, '2026-05-31T21:30:08.061Z', 2)`,
    ).run();
    db.exec("UPDATE beers SET untappd_lookup_at = NULL, untappd_lookup_count = 0 WHERE untappd_id IS NULL");

    const orphan = db.prepare(
      "SELECT untappd_lookup_at AS at, untappd_lookup_count AS cnt FROM beers WHERE untappd_id IS NULL",
    ).get() as { at: string | null; cnt: number };
    const matched = db.prepare(
      "SELECT untappd_lookup_at AS at, untappd_lookup_count AS cnt FROM beers WHERE untappd_id = 12345",
    ).get() as { at: string | null; cnt: number };
    expect(orphan).toEqual({ at: null, cnt: 0 });
    expect(matched).toEqual({ at: '2026-05-31T21:30:08.061Z', cnt: 2 });
  });

  it('migration v8 creates api_tokens table with token_hash PK', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .prepare("PRAGMA table_info(api_tokens)")
      .all() as { name: string; pk: number; notnull: number }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['token_hash', 'telegram_id', 'created_at']),
    );
    expect(cols.find((c) => c.name === 'token_hash')?.pk).toBe(1);
    expect(cols.find((c) => c.name === 'token_hash')?.notnull).toBe(1);

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='api_tokens'")
      .all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain('idx_api_tokens_telegram');
  });

  it('api_tokens enforces the telegram_id foreign key (reject + CASCADE)', () => {
    const db = openDb(':memory:');
    migrate(db);

    // Reject: a token for a non-existent user violates the FK.
    expect(() =>
      db
        .prepare('INSERT INTO api_tokens (token_hash, telegram_id) VALUES (?, ?)')
        .run('hash-orphan', 999),
    ).toThrow(/FOREIGN KEY/);

    // CASCADE: deleting the owning profile removes its token.
    db.prepare('INSERT INTO user_profiles (telegram_id) VALUES (?)').run(42);
    db.prepare('INSERT INTO api_tokens (token_hash, telegram_id) VALUES (?, ?)').run('hash-42', 42);
    db.prepare('DELETE FROM user_profiles WHERE telegram_id = ?').run(42);
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE telegram_id = ?')
      .get(42) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('migration v9 creates extension_releases with version PK and nullable file_id', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .prepare('PRAGMA table_info(extension_releases)')
      .all() as { name: string; pk: number; notnull: number }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['version', 'sha256', 'notes', 'file_id', 'published_at', 'attached_by']),
    );
    expect(cols.find((c) => c.name === 'version')?.pk).toBe(1);
    expect(cols.find((c) => c.name === 'sha256')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'file_id')?.notnull).toBe(0);
  });

  test('migration v10 creates enrich_failures table with beer_id PK', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(enrich_failures)').all() as { name: string; pk: number }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'beer_id', 'brewery', 'name', 'search_url', 'outcome',
        'candidates_count', 'candidates_summary', 'fail_count', 'last_at',
      ]),
    );
    expect(cols.find((c) => c.name === 'beer_id')?.pk).toBe(1);
  });

  test('enrich_failures has a source_url column defaulting to empty string', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db.prepare(`PRAGMA table_info(enrich_failures)`).all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === 'source_url');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
  });
});
