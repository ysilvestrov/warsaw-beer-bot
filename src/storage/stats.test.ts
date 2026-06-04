import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub } from './pubs';
import { upsertBeer } from './beers';
import { createSnapshot, insertTaps } from './snapshots';
import { collectStatus } from './stats';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function tap(beerRef: string) {
  return { tap_number: 1, beer_ref: beerRef, brewery_ref: null, abv: null, ibu: null, style: null, u_rating: null };
}

function seed() {
  const db = fresh();
  // beers: matched+rated, matched+no-rating, orphan
  upsertBeer(db, { untappd_id: 100, name: 'A', brewery: 'X', style: null, abv: null, rating_global: 4.0, normalized_name: 'a', normalized_brewery: 'x' });
  upsertBeer(db, { untappd_id: 101, name: 'B', brewery: 'X', style: null, abv: null, rating_global: null, normalized_name: 'b', normalized_brewery: 'x' });
  upsertBeer(db, { untappd_id: null, name: 'C', brewery: 'X', style: null, abv: null, rating_global: null, normalized_name: 'c', normalized_brewery: 'x' });
  // users: one linked, one not
  db.prepare('INSERT INTO user_profiles (telegram_id, untappd_username) VALUES (?, ?)').run(1, 'bob');
  db.prepare('INSERT INTO user_profiles (telegram_id, untappd_username) VALUES (?, ?)').run(2, null);
  // pubs + snapshots
  const a = upsertPub(db, { slug: 'a', name: 'a', address: null, lat: null, lon: null });
  const b = upsertPub(db, { slug: 'b', name: 'b', address: null, lat: null, lon: null });
  const aOld = createSnapshot(db, a, '2026-06-01T12:00:00Z'); // >24h ago
  insertTaps(db, aOld, [tap('B1')]);                          // B1 seen in the past
  const aNew = createSnapshot(db, a, '2026-06-04T06:00:00Z'); // 6h ago, latest for a
  insertTaps(db, aNew, [tap('A1'), tap('A2')]);
  const bNew = createSnapshot(db, b, '2026-06-04T09:00:00Z'); // 3h ago, latest for b
  insertTaps(db, bNew, [tap('B1')]);                          // B1 again → NOT new
  return db;
}

test('collectStatus computes all metrics', () => {
  const db = seed();
  const m = collectStatus(db, new Date('2026-06-04T12:00:00Z'));
  expect(m).toEqual({
    lastScrapeHoursAgo: 3,
    pubsScraped24h: 2,
    beersTotal: 3,
    beersMatched: 2,
    orphansPending: 1,
    ratingsMissing: 1,
    snapshots: 3,
    taps: 4,
    dbSizeMb: null,
    usersTotal: 2,
    usersLinked: 1,
    onTapDistinct: 3, // A1, A2, B1 (latest snapshots of a and b)
    onTapPubs: 2,
    newOnTap24h: 2,   // A1, A2 (B1 also appears in the old snapshot → excluded)
  });
});

test('collectStatus with empty DB: null scrape, zero counts', () => {
  const db = fresh();
  const m = collectStatus(db, new Date('2026-06-04T12:00:00Z'));
  expect(m.lastScrapeHoursAgo).toBeNull();
  expect(m.snapshots).toBe(0);
  expect(m.onTapDistinct).toBe(0);
  expect(m.newOnTap24h).toBe(0);
  expect(m.dbSizeMb).toBeNull();
});
