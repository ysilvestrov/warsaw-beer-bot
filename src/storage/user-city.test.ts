import { describe, test, expect } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, getUserCity, setUserCity } from './user_profiles';
import { OUTSIDE_CITY } from '../domain/cities';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('User city storage', () => {
  test('getUserCity returns OUTSIDE_CITY when unset (#399: new/extension-only users)', () => {
    const db = fresh();
    ensureProfile(db, 1);
    expect(getUserCity(db, 1)).toBe(OUTSIDE_CITY);
  });

  test('setUserCity round-trips a known city', () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUserCity(db, 1, 'krakow');
    expect(getUserCity(db, 1)).toBe('krakow');
  });

  test('setUserCity round-trips the pseudo-city', () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUserCity(db, 1, OUTSIDE_CITY);
    expect(getUserCity(db, 1)).toBe(OUTSIDE_CITY);
  });

  test('an unknown stored slug degrades to OUTSIDE_CITY, not to someone else’s city', () => {
    const db = fresh();
    ensureProfile(db, 1);
    db.prepare("UPDATE user_profiles SET city = 'atlantis' WHERE telegram_id = 1").run();
    expect(getUserCity(db, 1)).toBe(OUTSIDE_CITY);
  });
});
