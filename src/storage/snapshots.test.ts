import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub } from './pubs';
import { createSnapshot, latestSnapshot, insertTaps, tapsForSnapshot } from './snapshots';

function setup() {
  const db = openDb(':memory:'); migrate(db);
  const pubId = upsertPub(db, { slug: 'p', name: 'P', address: null, lat: null, lon: null });
  return { db, pubId };
}

test('createSnapshot + insertTaps roundtrip', () => {
  const { db, pubId } = setup();
  const snapId = createSnapshot(db, pubId, '2026-04-22T12:00:00Z');
  insertTaps(db, snapId, [
    { tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA', abv: 6.1, ibu: 55, style: 'AIPA', u_rating: 3.9 },
    { tap_number: 2, beer_ref: 'Stu Mostów Buty', brewery_ref: 'Stu Mostów', abv: 5.0, ibu: null, style: 'Pils', u_rating: 3.7 },
  ]);
  const rows = tapsForSnapshot(db, snapId);
  expect(rows).toHaveLength(2);
  expect(rows[0].beer_ref).toBe('PINTA Atak Chmielu');
});

test('latestSnapshot returns most recent per pub', () => {
  const { db, pubId } = setup();
  createSnapshot(db, pubId, '2026-04-22T10:00:00Z');
  const s2 = createSnapshot(db, pubId, '2026-04-22T20:00:00Z');
  expect(latestSnapshot(db, pubId)?.id).toBe(s2);
});
