import { openDb } from './db';
import { migrate } from './schema';
import { mergeCheckin, checkinsForUser, hasBeenDrunk } from './checkins';
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
