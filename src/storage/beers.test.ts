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
