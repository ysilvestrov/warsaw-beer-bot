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
        'schema_version',
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
});
