import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub } from './pubs';
import {
  getDistance,
  putDistance,
  putDistances,
  getDistancesFor,
  pairKey,
  clearForPub,
} from './pub_distances';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const a = upsertPub(db, { slug: 'a', name: 'A', address: null, lat: 52.0, lon: 21.0 });
  const b = upsertPub(db, { slug: 'b', name: 'B', address: null, lat: 52.1, lon: 21.0 });
  const c = upsertPub(db, { slug: 'c', name: 'C', address: null, lat: 52.0, lon: 21.1 });
  return { db, a, b, c };
}

describe('pub_distances storage', () => {
  test('getDistance returns null when nothing cached', () => {
    const { db, a, b } = setup();
    expect(getDistance(db, a, b)).toBeNull();
  });

  test('getDistance returns 0 for same pub without DB hit', () => {
    const { db, a } = setup();
    expect(getDistance(db, a, a)).toEqual({ meters: 0, source: 'osrm' });
  });

  test('putDistance + getDistance roundtrip is order-independent', () => {
    const { db, a, b } = setup();
    putDistance(db, b, a, 1234.5, 'osrm');
    expect(getDistance(db, a, b)).toEqual({ meters: 1234.5, source: 'osrm' });
    expect(getDistance(db, b, a)).toEqual({ meters: 1234.5, source: 'osrm' });
  });

  test('putDistance upserts on conflict', () => {
    const { db, a, b } = setup();
    putDistance(db, a, b, 100, 'haversine');
    putDistance(db, a, b, 200, 'osrm');
    expect(getDistance(db, a, b)).toEqual({ meters: 200, source: 'osrm' });
  });

  test('putDistances writes a batch in one transaction', () => {
    const { db, a, b, c } = setup();
    putDistances(db, [
      { idA: a, idB: b, meters: 100, source: 'osrm' },
      { idA: a, idB: c, meters: 200, source: 'osrm' },
      { idA: b, idB: c, meters: 300, source: 'osrm' },
    ]);
    expect(getDistance(db, a, b)?.meters).toBe(100);
    expect(getDistance(db, a, c)?.meters).toBe(200);
    expect(getDistance(db, b, c)?.meters).toBe(300);
  });

  test('getDistancesFor returns only pairs among given pubs', () => {
    const { db, a, b, c } = setup();
    putDistances(db, [
      { idA: a, idB: b, meters: 100, source: 'osrm' },
      { idA: a, idB: c, meters: 200, source: 'haversine' },
    ]);
    const m = getDistancesFor(db, [a, b]);
    expect(m.get(pairKey(a, b))).toEqual({ meters: 100, source: 'osrm' });
    expect(m.get(pairKey(a, c))).toBeUndefined();
  });

  test('clearForPub removes all rows touching that pub', () => {
    const { db, a, b, c } = setup();
    putDistances(db, [
      { idA: a, idB: b, meters: 100, source: 'osrm' },
      { idA: a, idB: c, meters: 200, source: 'osrm' },
      { idA: b, idB: c, meters: 300, source: 'osrm' },
    ]);
    clearForPub(db, a);
    expect(getDistance(db, a, b)).toBeNull();
    expect(getDistance(db, a, c)).toBeNull();
    expect(getDistance(db, b, c)?.meters).toBe(300);
  });

  test('CHECK (pub_id_a < pub_id_b) is enforced via canonical insert', () => {
    const { db, a, b } = setup();
    putDistance(db, b, a, 50, 'osrm');
    const row = db.prepare('SELECT pub_id_a, pub_id_b FROM pub_distances').get() as { pub_id_a: number; pub_id_b: number };
    expect(row.pub_id_a).toBeLessThan(row.pub_id_b);
  });
});
