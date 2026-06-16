import { openDb } from './db';
import { migrate } from './schema';
import { mergeCheckin, checkinsForUser, hasBeenDrunk, latestRatingsByBeer, countCheckins, checkinExists } from './checkins';
import { upsertBeer } from './beers';

function setup() {
  const db = openDb(':memory:'); migrate(db);
  const beerId = upsertBeer(db, {
    name: 'Atak', brewery: 'Pinta', style: 'IPA', abv: 6, rating_global: 3.9,
    normalized_name: 'atak', normalized_brewery: 'pinta',
  });
  return { db, beerId };
}

test('mergeCheckin is idempotent on (telegram_id, checkin_id)', () => {
  const { db, beerId } = setup();
  mergeCheckin(db, { checkin_id: 'c1', telegram_id: 10, beer_id: beerId,
    user_rating: 4.0, checkin_at: '2026-04-22T10:00:00Z', venue: 'Home' });
  mergeCheckin(db, { checkin_id: 'c1', telegram_id: 10, beer_id: beerId,
    user_rating: 4.5, checkin_at: '2026-04-22T10:00:00Z', venue: 'Home' });
  const all = checkinsForUser(db, 10);
  expect(all).toHaveLength(1);
  expect(all[0].user_rating).toBe(4.5);
});

test('hasBeenDrunk ignores other users', () => {
  const { db, beerId } = setup();
  mergeCheckin(db, { checkin_id: 'c', telegram_id: 10, beer_id: beerId,
    user_rating: null, checkin_at: '2026-04-22T10:00:00Z', venue: null });
  expect(hasBeenDrunk(db, 10, beerId)).toBe(true);
  expect(hasBeenDrunk(db, 11, beerId)).toBe(false);
});

describe('latestRatingsByBeer', () => {
  it('returns the most recent non-null rating per beer for the user', () => {
    const db = openDb(':memory:'); migrate(db);
    const beerA = upsertBeer(db, { name: 'A', brewery: 'B', normalized_name: 'a', normalized_brewery: 'b' });
    const beerB = upsertBeer(db, { name: 'C', brewery: 'B', normalized_name: 'c', normalized_brewery: 'b' });
    const base = { telegram_id: 1, venue: null as string | null };
    mergeCheckin(db, { ...base, checkin_id: 'c1', beer_id: beerA, user_rating: 3.0, checkin_at: '2026-01-01T00:00:00Z' });
    mergeCheckin(db, { ...base, checkin_id: 'c2', beer_id: beerA, user_rating: 4.5, checkin_at: '2026-03-01T00:00:00Z' });
    mergeCheckin(db, { ...base, checkin_id: 'c3', beer_id: beerB, user_rating: null, checkin_at: '2026-03-02T00:00:00Z' });
    const map = latestRatingsByBeer(db, 1);
    expect(map.get(beerA)).toBe(4.5);
    expect(map.has(beerB)).toBe(false);
  });

  it('falls back to an older non-null rating when the newest is null', () => {
    const db = openDb(':memory:'); migrate(db);
    const beer = upsertBeer(db, { name: 'X', brewery: 'Y', normalized_name: 'x', normalized_brewery: 'y' });
    const base = { telegram_id: 1, venue: null as string | null };
    mergeCheckin(db, { ...base, checkin_id: 'd1', beer_id: beer, user_rating: 3.7, checkin_at: '2026-01-01T00:00:00Z' });
    mergeCheckin(db, { ...base, checkin_id: 'd2', beer_id: beer, user_rating: null, checkin_at: '2026-05-01T00:00:00Z' });
    expect(latestRatingsByBeer(db, 1).get(beer)).toBe(3.7);
  });
});

describe('checkinExists', () => {
  it('is true only after a check-in is merged for that user', () => {
    const db = openDb(':memory:'); migrate(db);
    expect(checkinExists(db, 1, 'c1')).toBe(false);
    mergeCheckin(db, { checkin_id: 'c1', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2026-01-01', venue: null });
    expect(checkinExists(db, 1, 'c1')).toBe(true);
    expect(checkinExists(db, 2, 'c1')).toBe(false);
  });
});

describe('countCheckins', () => {
  it('counts rows for the given user only', () => {
    const db = openDb(':memory:'); migrate(db);
    mergeCheckin(db, { checkin_id: 'a', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2026-01-01', venue: null });
    mergeCheckin(db, { checkin_id: 'b', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2026-01-02', venue: null });
    mergeCheckin(db, { checkin_id: 'a', telegram_id: 2, beer_id: null, user_rating: null, checkin_at: '2026-01-01', venue: null });
    expect(countCheckins(db, 1)).toBe(2);
    expect(countCheckins(db, 2)).toBe(1);
    expect(countCheckins(db, 3)).toBe(0);
  });
});
