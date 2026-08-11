import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile, setUserCity } from '../storage/user_profiles';
import { hasCityScopedAccess } from './city-access';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('a user with a real city has access', () => {
  const db = fresh();
  ensureProfile(db, 1);
  setUserCity(db, 1, 'krakow');

  expect(hasCityScopedAccess(db, 1)).toBe(true);
});

test('a user with no city row at all has no access', () => {
  const db = fresh();

  expect(hasCityScopedAccess(db, 2)).toBe(false);
});

test('a user who explicitly picked outside-pl has no access', () => {
  const db = fresh();
  ensureProfile(db, 3);
  setUserCity(db, 3, 'outside-pl');

  expect(hasCityScopedAccess(db, 3)).toBe(false);
});

test('a user with a stale/unknown stored slug has no access', () => {
  const db = fresh();
  ensureProfile(db, 4);
  setUserCity(db, 4, 'some-removed-city');

  expect(hasCityScopedAccess(db, 4)).toBe(false);
});
