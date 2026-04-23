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
        'match_links', 'user_profiles', 'user_filters', 'schema_version',
      ]),
    );
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});
