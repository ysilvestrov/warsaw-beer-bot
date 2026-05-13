import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer } from './beers';
import { mergeCheckin } from './checkins';
import { markHad, hadBeerIds, triedBeerIds } from './untappd_had';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seedBeer(db: ReturnType<typeof fresh>, name: string): number {
  return upsertBeer(db, {
    untappd_id: null,
    name,
    brewery: 'Anon',
    style: null,
    abv: null,
    rating_global: null,
    normalized_name: name.toLowerCase(),
    normalized_brewery: 'anon',
  });
}

describe('markHad', () => {
  test('inserts a new (user, beer) pair', () => {
    const db = fresh();
    const beerId = seedBeer(db, 'Atak');
    markHad(db, 42, beerId, '2026-05-12T10:00:00Z');

    const row = db
      .prepare('SELECT telegram_id, beer_id, last_seen_at FROM untappd_had')
      .get() as { telegram_id: number; beer_id: number; last_seen_at: string };
    expect(row).toEqual({
      telegram_id: 42,
      beer_id: beerId,
      last_seen_at: '2026-05-12T10:00:00Z',
    });
  });

  test('upserts: same pair twice updates last_seen_at, no duplicate row', () => {
    const db = fresh();
    const beerId = seedBeer(db, 'Atak');
    markHad(db, 42, beerId, '2026-05-12T10:00:00Z');
    markHad(db, 42, beerId, '2026-05-12T11:00:00Z');

    const rows = db
      .prepare('SELECT last_seen_at FROM untappd_had WHERE telegram_id = ? AND beer_id = ?')
      .all(42, beerId) as { last_seen_at: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].last_seen_at).toBe('2026-05-12T11:00:00Z');
  });

  test('different users for same beer get separate rows', () => {
    const db = fresh();
    const beerId = seedBeer(db, 'Atak');
    markHad(db, 42, beerId, '2026-05-12T10:00:00Z');
    markHad(db, 99, beerId, '2026-05-12T10:00:00Z');

    const count = (db.prepare('SELECT COUNT(*) AS c FROM untappd_had').get() as { c: number }).c;
    expect(count).toBe(2);
  });
});

describe('hadBeerIds', () => {
  test('returns empty set for user with no had rows', () => {
    const db = fresh();
    expect(hadBeerIds(db, 42)).toEqual(new Set());
  });

  test('returns just the beer_ids for the given user', () => {
    const db = fresh();
    const a = seedBeer(db, 'A');
    const b = seedBeer(db, 'B');
    const c = seedBeer(db, 'C');
    markHad(db, 42, a, '2026-05-12T10:00:00Z');
    markHad(db, 42, b, '2026-05-12T10:00:00Z');
    markHad(db, 99, c, '2026-05-12T10:00:00Z');

    expect(hadBeerIds(db, 42)).toEqual(new Set([a, b]));
    expect(hadBeerIds(db, 99)).toEqual(new Set([c]));
  });
});

describe('triedBeerIds', () => {
  test('returns union of drunkBeerIds and hadBeerIds', () => {
    const db = fresh();
    const checkedIn = seedBeer(db, 'Checked-in');
    const had = seedBeer(db, 'Had');
    const both = seedBeer(db, 'Both');

    mergeCheckin(db, {
      checkin_id: 'ci-1',
      telegram_id: 42,
      beer_id: checkedIn,
      user_rating: null,
      checkin_at: '2026-05-01T00:00:00Z',
      venue: null,
    });
    mergeCheckin(db, {
      checkin_id: 'ci-2',
      telegram_id: 42,
      beer_id: both,
      user_rating: null,
      checkin_at: '2026-05-01T00:00:00Z',
      venue: null,
    });
    markHad(db, 42, had, '2026-05-12T10:00:00Z');
    markHad(db, 42, both, '2026-05-12T10:00:00Z');

    expect(triedBeerIds(db, 42)).toEqual(new Set([checkedIn, had, both]));
  });

  test('does not leak across users', () => {
    const db = fresh();
    const a = seedBeer(db, 'A');
    const b = seedBeer(db, 'B');
    mergeCheckin(db, {
      checkin_id: 'ci-1',
      telegram_id: 42,
      beer_id: a,
      user_rating: null,
      checkin_at: '2026-05-01T00:00:00Z',
      venue: null,
    });
    markHad(db, 99, b, '2026-05-12T10:00:00Z');

    expect(triedBeerIds(db, 42)).toEqual(new Set([a]));
    expect(triedBeerIds(db, 99)).toEqual(new Set([b]));
  });
});
