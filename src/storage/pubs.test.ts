import { describe, test, expect } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub, listPubs, setPubCoords } from './pubs';
import { putDistance, getDistance } from './pub_distances';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const base = { address: null, lat: null, lon: null };

describe('pubs storage', () => {
  test('upsertPub inserts a new pub and updates metadata in place', () => {
    const db = fresh();
    const id = upsertPub(db, { slug: 'beer-bones', name: 'Beer & Bones', address: 'Żurawia 32/34', lat: 52.228, lon: 21.013, city: 'warszawa' });
    expect(id).toBeGreaterThan(0);
    const id2 = upsertPub(db, { slug: 'beer-bones', name: 'Beer & Bones CB&M', address: 'Żurawia 32/34', lat: null, lon: null, city: 'warszawa' });
    expect(id2).toBe(id);
    const pubs = listPubs(db);
    expect(pubs[0].name).toBe('Beer & Bones CB&M');
    expect(pubs[0].lat).toBeCloseTo(52.228);
  });

  test('setPubCoords fills missing coordinates', () => {
    const db = fresh();
    const id = upsertPub(db, { slug: 'x', name: 'X', address: 'A', lat: null, lon: null, city: 'warszawa' });
    setPubCoords(db, id, 1.0, 2.0);
    expect(listPubs(db)[0].lat).toBe(1.0);
  });

  test('upsertPub keeps cached distances when null coords come through (COALESCE)', () => {
    const db = fresh();
    const a = upsertPub(db, { slug: 'a', name: 'A', address: null, lat: 1.0, lon: 2.0, city: 'warszawa' });
    const b = upsertPub(db, { slug: 'b', name: 'B', address: null, lat: 3.0, lon: 4.0, city: 'warszawa' });
    putDistance(db, a, b, 999, 'osrm');

    upsertPub(db, { slug: 'a', name: 'A', address: null, lat: null, lon: null, city: 'warszawa' });
    expect(getDistance(db, a, b)?.meters).toBe(999);
  });

  test('upsertPub invalidates cached distances when coords change', () => {
    const db = fresh();
    const a = upsertPub(db, { slug: 'a', name: 'A', address: null, lat: 1.0, lon: 2.0, city: 'warszawa' });
    const b = upsertPub(db, { slug: 'b', name: 'B', address: null, lat: 3.0, lon: 4.0, city: 'warszawa' });
    putDistance(db, a, b, 999, 'osrm');

    upsertPub(db, { slug: 'a', name: 'A', address: null, lat: 1.5, lon: 2.5, city: 'warszawa' });
    expect(getDistance(db, a, b)).toBeNull();
  });

  test('setPubCoords invalidates cached distances', () => {
    const db = fresh();
    const a = upsertPub(db, { slug: 'a', name: 'A', address: null, lat: 1.0, lon: 2.0, city: 'warszawa' });
    const b = upsertPub(db, { slug: 'b', name: 'B', address: null, lat: 3.0, lon: 4.0, city: 'warszawa' });
    putDistance(db, a, b, 999, 'osrm');

    setPubCoords(db, a, 1.5, 2.5);
    expect(getDistance(db, a, b)).toBeNull();
  });

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
