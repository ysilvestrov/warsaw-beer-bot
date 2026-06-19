import { describe, test, expect } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, getUserCity, setUserCity } from './user_profiles';
import { DEFAULT_CITY } from '../domain/cities';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('User city storage', () => {
  test('getUserCity returns DEFAULT_CITY when unset', () => {
    const db = fresh();
    ensureProfile(db, 1);
    expect(getUserCity(db, 1)).toBe(DEFAULT_CITY);
  });

  test('setUserCity round-trips a known city', () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUserCity(db, 1, 'krakow');
    expect(getUserCity(db, 1)).toBe('krakow');
  });

  test('getUserCity falls back to default when stored slug is unknown', () => {
    const db = fresh();
    ensureProfile(db, 1);
    db.prepare("UPDATE user_profiles SET city = 'atlantis' WHERE telegram_id = 1").run();
    expect(getUserCity(db, 1)).toBe(DEFAULT_CITY);
  });
});
