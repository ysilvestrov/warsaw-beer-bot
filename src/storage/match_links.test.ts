import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer } from './beers';
import { upsertMatch, getMatch, listUnreviewedBelow } from './match_links';

function setup() {
  const db = openDb(':memory:'); migrate(db);
  const id = upsertBeer(db, {
    name: 'X', brewery: 'B', style: null, abv: null, rating_global: null,
    normalized_name: 'x', normalized_brewery: 'b',
  });
  return { db, beerId: id };
}

test('upsertMatch upserts by ontap_ref', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'PINTA|atak', beerId, 0.9);
  upsertMatch(db, 'PINTA|atak', beerId, 1.0);
  const m = getMatch(db, 'PINTA|atak');
  expect(m?.confidence).toBe(1.0);
});

test('listUnreviewedBelow returns low-confidence, not yet reviewed', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'a', beerId, 0.7);
  upsertMatch(db, 'b', beerId, 0.95);
  expect(listUnreviewedBelow(db, 0.85).map((r) => r.ontap_ref)).toEqual(['a']);
});
