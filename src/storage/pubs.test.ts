import { describe, test, expect } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub, listPubs } from './pubs';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const base = { address: null, lat: null, lon: null };

describe('pubs storage', () => {
  test('upsertPub persists city on insert and update', () => {
    const db = fresh();
    const id = upsertPub(db, { slug: 'a', name: 'A', city: 'krakow', ...base });
    expect((listPubs(db).find((p) => p.id === id))?.city).toBe('krakow');
    upsertPub(db, { slug: 'a', name: 'A2', city: 'wroclaw', ...base });
    expect((listPubs(db).find((p) => p.id === id))?.city).toBe('wroclaw');
  });

  test('listPubs filters by city when given, returns all otherwise', () => {
    const db = fresh();
    upsertPub(db, { slug: 'w', name: 'W', city: 'warszawa', ...base });
    upsertPub(db, { slug: 'k', name: 'K', city: 'krakow', ...base });
    expect(listPubs(db).length).toBe(2);
    expect(listPubs(db, 'krakow').map((p) => p.slug)).toEqual(['k']);
    expect(listPubs(db, 'gdansk')).toEqual([]);
  });
});
