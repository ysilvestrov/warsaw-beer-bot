import { openDb } from './db';
import { migrate } from './schema';
import { seedBeer } from './seed-beer.testing';
import { mergeCheckin } from './checkins';
import { markHad, hadBeerIds, triedBeerIds, countHadWithoutCheckins } from './untappd_had';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seedNamedBeer(db: ReturnType<typeof fresh>, name: string): number {
  return seedBeer(db, {
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
  test('stores and updates personal ratings, including zero, without crossing users', () => {
    const db = fresh();
    const beerId = seedNamedBeer(db, 'Atak');
    markHad(db, 42, beerId, '2026-09-28T03:00:00Z', 4.25);
    markHad(db, 99, beerId, '2026-09-28T03:00:00Z', 5);
    markHad(db, 42, beerId, '2026-09-29T03:00:00Z', 0);
    expect(db.prepare('SELECT telegram_id, user_rating FROM untappd_had ORDER BY telegram_id').all())
      .toEqual([{ telegram_id: 42, user_rating: 0 }, { telegram_id: 99, user_rating: 5 }]);
  });

  test.each([null, undefined, NaN, Infinity, -0.1, 5.1])('retains an observed rating when the next value is %s', (rating) => {
    const db = fresh();
    const beerId = seedNamedBeer(db, 'Atak');
    markHad(db, 42, beerId, '2026-09-28T03:00:00Z', 4.25);
    markHad(db, 42, beerId, '2026-09-29T03:00:00Z', rating);
    expect(db.prepare('SELECT user_rating, last_seen_at FROM untappd_had').get())
      .toEqual({ user_rating: 4.25, last_seen_at: '2026-09-29T03:00:00Z' });
  });

  test('inserts a new (user, beer) pair', () => {
    const db = fresh();
    const beerId = seedNamedBeer(db, 'Atak');
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
    const beerId = seedNamedBeer(db, 'Atak');
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
    const beerId = seedNamedBeer(db, 'Atak');
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
    const a = seedNamedBeer(db, 'A');
    const b = seedNamedBeer(db, 'B');
    const c = seedNamedBeer(db, 'C');
    markHad(db, 42, a, '2026-05-12T10:00:00Z');
    markHad(db, 42, b, '2026-05-12T10:00:00Z');
    markHad(db, 99, c, '2026-05-12T10:00:00Z');

    expect(hadBeerIds(db, 42)).toEqual(new Set([a, b]));
    expect(hadBeerIds(db, 99)).toEqual(new Set([c]));
  });
});

test('counts beers without this user’s check-ins regardless of observation time or rating', () => {
  const db = fresh();
  const a = seedNamedBeer(db, 'A');
  const b = seedNamedBeer(db, 'B');
  const c = seedNamedBeer(db, 'C');
  expect(countHadWithoutCheckins(db, 1)).toBe(0);
  markHad(db, 1, a, '2026-01-01T00:00:00Z', 4.25);
  markHad(db, 1, b, '2026-09-28T00:00:00Z');
  markHad(db, 2, c, '2026-09-28T00:00:00Z');
  mergeCheckin(db, { telegram_id: 2, beer_id: a, checkin_id: '1',
    user_rating: null, checkin_at: '2026-01-01T00:00:00Z', venue: null });
  expect(countHadWithoutCheckins(db, 1)).toBe(2);
  mergeCheckin(db, { telegram_id: 1, beer_id: b, checkin_id: '2',
    user_rating: null, checkin_at: '2026-01-01T00:00:00Z', venue: null });
  mergeCheckin(db, { telegram_id: 1, beer_id: b, checkin_id: '3',
    user_rating: 4, checkin_at: '2026-02-01T00:00:00Z', venue: null });
  expect(countHadWithoutCheckins(db, 1)).toBe(1);
  expect(countHadWithoutCheckins(db, 2)).toBe(1);
});

describe('triedBeerIds', () => {
  test('returns union of drunkBeerIds and hadBeerIds', () => {
    const db = fresh();
    const checkedIn = seedNamedBeer(db, 'Checked-in');
    const had = seedNamedBeer(db, 'Had');
    const both = seedNamedBeer(db, 'Both');

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
    const a = seedNamedBeer(db, 'A');
    const b = seedNamedBeer(db, 'B');
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
