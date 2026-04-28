import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, setUntappdUsername, getProfile, getUserLanguage, setUserLanguage } from './user_profiles';
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

test('getUserLanguage returns null when nothing stored', () => {
  const db = fresh();
  ensureProfile(db, 42);
  expect(getUserLanguage(db, 42)).toBeNull();
});

test('getUserLanguage returns null when user has no profile row', () => {
  const db = fresh();
  expect(getUserLanguage(db, 999)).toBeNull();
});

test('setUserLanguage persists and getUserLanguage roundtrips', () => {
  const db = fresh();
  ensureProfile(db, 42);
  setUserLanguage(db, 42, 'uk');
  expect(getUserLanguage(db, 42)).toBe('uk');
  setUserLanguage(db, 42, 'pl');
  expect(getUserLanguage(db, 42)).toBe('pl');
});

test('getUserLanguage returns null when DB has unrecognized value', () => {
  const db = fresh();
  ensureProfile(db, 42);
  // Simulate manual DB tampering / future locale removed in downgrade.
  db.prepare('UPDATE user_profiles SET language = ? WHERE telegram_id = ?').run('xx', 42);
  expect(getUserLanguage(db, 42)).toBeNull();
});
