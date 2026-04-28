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
});
