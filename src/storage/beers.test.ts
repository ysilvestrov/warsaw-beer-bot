import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer, findBeerByNormalized } from './beers';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('upsertBeer inserts then updates by normalized key', () => {
  const db = fresh();
  const id1 = upsertBeer(db, {
    name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA',
    abv: 6.1, rating_global: 3.9,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  const id2 = upsertBeer(db, {
    name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA',
    abv: 6.2, rating_global: 3.95,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  expect(id1).toBe(id2);
  const row = findBeerByNormalized(db, 'pinta', 'atak chmielu');
  expect(row?.abv).toBeCloseTo(6.2);
});

test('findBeerByNormalized returns null when absent', () => {
  expect(findBeerByNormalized(fresh(), 'x', 'y')).toBeNull();
});

test('upsertBeer matches by untappd_id when normalization drifts', () => {
  // Simulates the production state where a row was stored under one
  // normalized form (e.g. legacy "captain hazy foreign legion" without
  // numeric tokens) and re-import passes a different normalized form
  // (current "captain hazy foreign legion 2025"). Without the
  // untappd_id-first lookup, the SELECT misses, INSERT fires, and the
  // UNIQUE constraint on beers.untappd_id throws.
  const db = fresh();
  const oldId = upsertBeer(db, {
    untappd_id: 6455502,
    name: 'Captain Hazy - Foreign Legion 2025',
    brewery: 'KOMPAAN Dutch Craft Beer Company',
    style: null, abv: null, rating_global: null,
    normalized_name: 'captain hazy foreign legion',
    normalized_brewery: 'kompaan dutch craft beer',
  });
  const newId = upsertBeer(db, {
    untappd_id: 6455502,
    name: 'Captain Hazy - Foreign Legion 2025',
    brewery: 'KOMPAAN Dutch Craft Beer Company',
    style: 'Bock - Doppelbock', abv: 8.0, rating_global: 3.55,
    normalized_name: 'captain hazy foreign legion 2025',
    normalized_brewery: 'kompaan dutch craft beer',
  });
  expect(newId).toBe(oldId);
  const row = db
    .prepare('SELECT name, style, abv, rating_global, normalized_name FROM beers WHERE id = ?')
    .get(oldId) as { name: string; style: string; abv: number; rating_global: number; normalized_name: string };
  expect(row.rating_global).toBeCloseTo(3.55);
  expect(row.style).toBe('Bock - Doppelbock');
  expect(row.normalized_name).toBe('captain hazy foreign legion 2025');
});

test('upsertBeer falls back to (normalized_brewery, normalized_name) when untappd_id is null', () => {
  const db = fresh();
  const id1 = upsertBeer(db, {
    untappd_id: null, name: 'Foo', brewery: 'Bar',
    style: null, abv: null, rating_global: null,
    normalized_name: 'foo', normalized_brewery: 'bar',
  });
  const id2 = upsertBeer(db, {
    untappd_id: null, name: 'Foo', brewery: 'Bar',
    style: null, abv: 5.0, rating_global: null,
    normalized_name: 'foo', normalized_brewery: 'bar',
  });
  expect(id2).toBe(id1);
});

test('upsertBeer prefers untappd_id row over a normalized-only match', () => {
  // A canonical Untappd-side row exists with bid=42; an orphan ontap-side
  // row exists with same normalized but null bid. Re-importing the bid'd
  // beer must update the canonical, not the orphan.
  const db = fresh();
  const canonId = upsertBeer(db, {
    untappd_id: 42, name: 'Foo', brewery: 'Bar',
    style: null, abv: null, rating_global: null,
    normalized_name: 'foo', normalized_brewery: 'bar',
  });
  const orphanId = upsertBeer(db, {
    untappd_id: null, name: 'Foo', brewery: 'Bar',
    style: null, abv: null, rating_global: null,
    normalized_name: 'foo extra', normalized_brewery: 'bar',
  });
  expect(orphanId).not.toBe(canonId);
  // Re-import: bid=42, but the data lookup happens to also match orphan by normalized
  const updatedId = upsertBeer(db, {
    untappd_id: 42, name: 'Foo Renamed', brewery: 'Bar',
    style: null, abv: null, rating_global: 4.0,
    normalized_name: 'foo extra', normalized_brewery: 'bar',
  });
  expect(updatedId).toBe(canonId);
  const orphan = db.prepare('SELECT name FROM beers WHERE id = ?').get(orphanId) as { name: string };
  expect(orphan.name).toBe('Foo'); // orphan untouched
});
