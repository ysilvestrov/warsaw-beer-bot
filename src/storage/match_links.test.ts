import { openDb } from './db';
import { migrate } from './schema';
import { seedBeer } from './seed-beer.testing';
import { upsertMatch, getMatch, listUnreviewedBelow, tapBreweryKey } from './match_links';

function setup() {
  const db = openDb(':memory:'); migrate(db);
  const id = seedBeer(db, {
    name: 'X', brewery: 'B', style: null, abv: null, rating_global: null,
    normalized_name: 'x', normalized_brewery: 'b',
  });
  const other = seedBeer(db, {
    name: 'Y', brewery: 'C', style: null, abv: null, rating_global: null,
    normalized_name: 'y', normalized_brewery: 'c',
  });
  return { db, beerId: id, otherId: other };
}

test('upsertMatch upserts by the brewery + tap name pair', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'PINTA', 'Atak', beerId, 0.9);
  upsertMatch(db, 'PINTA', 'Atak', beerId, 1.0);
  expect(getMatch(db, 'PINTA', 'Atak')?.confidence).toBe(1.0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM match_links').get()).toEqual({ n: 1 });
});

test('#632 the same tap name of two breweries keeps two links, and one never clears the other\'s merge stamp', () => {
  const { db, beerId, otherId } = setup();
  upsertMatch(db, 'Friedenfelser Brewery', 'Hefeweizen', beerId, 1.0);
  upsertMatch(db, 'Brauerei Rittmayer Hallerndorf Brewery', 'Hefeweizen', otherId, 1.0);
  db.prepare(
    "UPDATE match_links SET merged_at = '2026-09-15T00:03:44Z' WHERE brewery_ref = 'Brauerei Rittmayer Hallerndorf Brewery'",
  ).run();

  // Матчер паба Friedenfelser переписує лише свою пару.
  upsertMatch(db, 'Friedenfelser Brewery', 'Hefeweizen', beerId, 1.0);

  expect(getMatch(db, 'Friedenfelser Brewery', 'Hefeweizen')?.untappd_beer_id).toBe(beerId);
  expect(getMatch(db, 'Brauerei Rittmayer Hallerndorf Brewery', 'Hefeweizen')).toMatchObject({
    untappd_beer_id: otherId, merged_at: '2026-09-15T00:03:44Z',
  });
});

test('#632 a tap without a brewery is its own pair: NULL and empty text are the same key', () => {
  const { db, beerId } = setup();
  expect(tapBreweryKey(null)).toBe('');
  upsertMatch(db, null, 'Hefeweizen', beerId, 1.0);
  expect(getMatch(db, '', 'Hefeweizen')?.untappd_beer_id).toBe(beerId);
  expect(getMatch(db, 'Friedenfelser Brewery', 'Hefeweizen')).toBeNull();
});

test('listUnreviewedBelow returns low-confidence, not yet reviewed', () => {
  const { db, beerId } = setup();
  upsertMatch(db, null, 'a', beerId, 0.7);
  upsertMatch(db, null, 'b', beerId, 0.95);
  expect(listUnreviewedBelow(db, 0.85).map((r) => r.ontap_ref)).toEqual(['a']);
});

test('upsertMatch clears a merge stamp — a matcher write is never merge-derived', () => {
  const { db, beerId } = setup();
  upsertMatch(db, 'PINTA', 'atak', beerId, 1.0);
  db.prepare("UPDATE match_links SET merged_at = '2026-07-30T00:00:00Z' WHERE ontap_ref = 'atak'").run();

  upsertMatch(db, 'PINTA', 'atak', beerId, 0.8);

  expect(getMatch(db, 'PINTA', 'atak')?.merged_at).toBeNull();
});
