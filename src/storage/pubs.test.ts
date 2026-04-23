import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub, listPubs, setPubCoords } from './pubs';

function fresh() {
  const db = openDb(':memory:'); migrate(db); return db;
}

test('upsertPub inserts a new pub and updates metadata in place', () => {
  const db = fresh();
  const id = upsertPub(db, { slug: 'beer-bones', name: 'Beer & Bones', address: 'Żurawia 32/34', lat: 52.228, lon: 21.013 });
  expect(id).toBeGreaterThan(0);
  const id2 = upsertPub(db, { slug: 'beer-bones', name: 'Beer & Bones CB&M', address: 'Żurawia 32/34', lat: null, lon: null });
  expect(id2).toBe(id);
  const pubs = listPubs(db);
  expect(pubs[0].name).toBe('Beer & Bones CB&M');
  expect(pubs[0].lat).toBeCloseTo(52.228);
});

test('setPubCoords fills missing coordinates', () => {
  const db = fresh();
  const id = upsertPub(db, { slug: 'x', name: 'X', address: 'A', lat: null, lon: null });
  setPubCoords(db, id, 1.0, 2.0);
  expect(listPubs(db)[0].lat).toBe(1.0);
});
