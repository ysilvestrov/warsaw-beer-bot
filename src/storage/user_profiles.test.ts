import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, getProfile, setUntappdUsername } from './user_profiles';
import { seedBeer } from './seed-beer.testing';
import { markHad } from './untappd_had';
import { mergeCheckin } from './checkins';

test('relinking clears only that user’s scraped ratings and preserves existing history', () => {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  ensureProfile(db, 2);
  setUntappdUsername(db, 1, 'old');
  setUntappdUsername(db, 2, 'other');
  const beerId = seedBeer(db, { name: 'Atak', brewery: 'Pinta', normalized_name: 'atak', normalized_brewery: 'pinta' });
  markHad(db, 1, beerId, '2026-09-28T03:00:00Z', 4.25);
  markHad(db, 2, beerId, '2026-09-28T03:00:00Z', 3);
  mergeCheckin(db, { telegram_id: 1, beer_id: beerId, checkin_id: '123',
    user_rating: 4, checkin_at: '2026-09-01T03:00:00Z', venue: null });
  setUntappdUsername(db, 1, 'OLD');
  expect(db.prepare('SELECT user_rating FROM untappd_had WHERE telegram_id = 1').get())
    .toEqual({ user_rating: 4.25 });
  setUntappdUsername(db, 1, 'new');
  expect(getProfile(db, 1)?.untappd_username).toBe('new');
  expect(db.prepare('SELECT telegram_id, user_rating FROM untappd_had ORDER BY telegram_id').all())
    .toEqual([{ telegram_id: 1, user_rating: null }, { telegram_id: 2, user_rating: 3 }]);
  expect(db.prepare('SELECT checkin_id, user_rating FROM checkins').all())
    .toEqual([{ checkin_id: '123', user_rating: 4 }]);
  db.close();
});
