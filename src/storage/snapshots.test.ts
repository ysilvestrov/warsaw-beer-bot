import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub } from './pubs';
import { createSnapshot, latestSnapshot, insertTaps, tapsForSnapshot, tapsForSnapshotWithBeer, currentTapStyles } from './snapshots';
import { upsertBeer } from './beers';
import { upsertMatch } from './match_links';

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

function setupWithBeer() {
  const out = setup();
  const snapId = createSnapshot(out.db, out.pubId, '2026-05-01T12:00:00Z');
  return { ...out, snapId };
}

describe('tapsForSnapshotWithBeer', () => {
  test('tap with non-NULL u_rating and no match → keeps tap u_rating, beer_id null', () => {
    const { db, snapId } = setupWithBeer();
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'Mystery Beer', brewery_ref: 'Anon', abv: 5, ibu: null, style: 'IPA', u_rating: 3.9 },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBe(3.9);
    expect(row.beer_id).toBeNull();
  });

  test('tap with NULL u_rating + matched beer carrying rating_global → fallback rating, beer_id set', () => {
    const { db, snapId } = setupWithBeer();
    const beerId = upsertBeer(db, {
      untappd_id: 100,
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: 'AIPA',
      abv: 6.1,
      rating_global: 3.85,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });
    upsertMatch(db, 'PINTA Atak Chmielu', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA', abv: 6.1, ibu: null, style: 'AIPA', u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBe(3.85);
    expect(row.beer_id).toBe(beerId);
  });

  test('tap with non-NULL u_rating + matched beer with different rating_global → COALESCE keeps tap u_rating', () => {
    const { db, snapId } = setupWithBeer();
    const beerId = upsertBeer(db, {
      untappd_id: 101,
      name: 'Buty Skejta',
      brewery: 'Stu Mostow',
      style: 'Pilsner',
      abv: 5.0,
      rating_global: 3.10,
      normalized_name: 'buty skejta',
      normalized_brewery: 'stu mostow',
    });
    upsertMatch(db, 'Stu Mostow Buty Skejta', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'Stu Mostow Buty Skejta', brewery_ref: 'Stu Mostow', abv: 5.0, ibu: null, style: 'Pilsner', u_rating: 3.7 },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBe(3.7);
    expect(row.beer_id).toBe(beerId);
  });

  test('tap with NULL u_rating + matched beer with NULL rating_global → NULL u_rating, beer_id set', () => {
    const { db, snapId } = setupWithBeer();
    const beerId = upsertBeer(db, {
      untappd_id: 102,
      name: 'New Release',
      brewery: 'New Brews',
      style: 'Lager',
      abv: 5.0,
      rating_global: null,
      normalized_name: 'new release',
      normalized_brewery: 'new brews',
    });
    upsertMatch(db, 'New Brews New Release', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'New Brews New Release', brewery_ref: 'New Brews', abv: 5.0, ibu: null, style: 'Lager', u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBeNull();
    expect(row.beer_id).toBe(beerId);
  });

  test('tap with no matching match_links row → NULL u_rating (when tap had it NULL), NULL beer_id', () => {
    const { db, snapId } = setupWithBeer();
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'Unmatched', brewery_ref: 'Nobody', abv: null, ibu: null, style: null, u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.u_rating).toBeNull();
    expect(row.beer_id).toBeNull();
  });

  test('matched beer with abv → prefers beers.abv over the (garbage) tap abv', () => {
    const { db, snapId } = setupWithBeer();
    const beerId = upsertBeer(db, {
      untappd_id: 6400148,
      name: 'Gardees II - 2025',
      brewery: 'Brasserie La Malpolon',
      style: 'Farmhouse Ale - Bière de Garde',
      abv: 8.4,
      rating_global: 3.85,
      normalized_name: 'gardees ii',
      normalized_brewery: 'brasserie la malpolon',
    });
    upsertMatch(db, 'GARDEES II - 2025', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 24, beer_ref: 'GARDEES II - 2025', brewery_ref: 'Brasserie La Malpolon Brewery', abv: 40, ibu: 8.4, style: null, u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.abv).toBe(8.4);
    expect(row.beer_id).toBe(beerId);
  });

  test('matched beer with NULL abv → falls back to tap abv', () => {
    const { db, snapId } = setupWithBeer();
    const beerId = upsertBeer(db, {
      untappd_id: 200,
      name: 'No Abv Beer',
      brewery: 'X',
      style: null,
      abv: null,
      rating_global: 3.5,
      normalized_name: 'no abv beer',
      normalized_brewery: 'x',
    });
    upsertMatch(db, 'X No Abv Beer', beerId, 1.0);
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'X No Abv Beer', brewery_ref: 'X', abv: 5.2, ibu: null, style: null, u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.abv).toBe(5.2);
  });

  test('orphan tap (no match) → keeps tap abv', () => {
    const { db, snapId } = setupWithBeer();
    insertTaps(db, snapId, [
      { tap_number: 1, beer_ref: 'Lonely', brewery_ref: 'Nobody', abv: 6.6, ibu: null, style: null, u_rating: null },
    ]);
    const [row] = tapsForSnapshotWithBeer(db, snapId);
    expect(row.abv).toBe(6.6);
  });

  test('preserves ORDER BY tap_number', () => {
    const { db, snapId } = setupWithBeer();
    insertTaps(db, snapId, [
      { tap_number: 3, beer_ref: 'C', brewery_ref: 'X', abv: null, ibu: null, style: null, u_rating: null },
      { tap_number: 1, beer_ref: 'A', brewery_ref: 'X', abv: null, ibu: null, style: null, u_rating: null },
      { tap_number: 2, beer_ref: 'B', brewery_ref: 'X', abv: null, ibu: null, style: null, u_rating: null },
    ]);
    const rows = tapsForSnapshotWithBeer(db, snapId);
    expect(rows.map((r) => r.beer_ref)).toEqual(['A', 'B', 'C']);
  });
});

test('currentTapStyles returns styles from the latest snapshot of each pub only', () => {
  const { db, pubId } = setup();
  const pubId2 = upsertPub(db, { slug: 'q', name: 'Q', address: null, lat: null, lon: null });

  // older snapshot for pub 1 — must be ignored
  const old = createSnapshot(db, pubId, '2026-06-01T10:00:00Z');
  insertTaps(db, old, [
    { tap_number: 1, beer_ref: 'old', brewery_ref: null, abv: 5, ibu: null, style: 'Porter - Baltic', u_rating: null },
  ]);
  // latest snapshot for pub 1
  const cur1 = createSnapshot(db, pubId, '2026-06-03T10:00:00Z');
  insertTaps(db, cur1, [
    { tap_number: 1, beer_ref: 'a', brewery_ref: null, abv: 6, ibu: null, style: 'IPA - American', u_rating: null },
    { tap_number: 2, beer_ref: 'b', brewery_ref: null, abv: 5, ibu: null, style: null, u_rating: null },
  ]);
  // latest snapshot for pub 2
  const cur2 = createSnapshot(db, pubId2, '2026-06-03T11:00:00Z');
  insertTaps(db, cur2, [
    { tap_number: 1, beer_ref: 'c', brewery_ref: null, abv: 7, ibu: null, style: 'Sour - Fruited', u_rating: null },
  ]);

  const styles = currentTapStyles(db).sort();
  expect(styles).toEqual(['IPA - American', 'Sour - Fruited']); // no Porter (old), no null
});
