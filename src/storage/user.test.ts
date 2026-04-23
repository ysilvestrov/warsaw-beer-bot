import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, setUntappdUsername, getProfile } from './user_profiles';
import { getFilters, setFilters } from './user_filters';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

test('ensureProfile is idempotent and setUntappdUsername sticks', () => {
  const db = fresh();
  ensureProfile(db, 42);
  ensureProfile(db, 42);
  setUntappdUsername(db, 42, 'yuriy');
  expect(getProfile(db, 42)?.untappd_username).toBe('yuriy');
});

test('filters round-trip styles array', () => {
  const db = fresh();
  ensureProfile(db, 42);
  setFilters(db, 42, { styles: ['IPA', 'Pils'], min_rating: 3.5, abv_min: 4, abv_max: 9, default_route_n: 7 });
  const f = getFilters(db, 42);
  expect(f?.styles).toEqual(['IPA', 'Pils']);
  expect(f?.default_route_n).toBe(7);
});
