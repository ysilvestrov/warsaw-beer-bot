import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub } from './pubs';
import { upsertBeer } from './beers';
import { createSnapshot, insertTaps } from './snapshots';
import { collectStatus } from './stats';
import { setJobState } from './job_state';
import { recordMatchUsage } from './api_usage';
import { previousDate, warsawDateAndHour } from '../domain/warsaw-time';

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
  const a = upsertPub(db, { slug: 'a', name: 'a', address: null, lat: null, lon: null, city: 'warszawa' });
  const b = upsertPub(db, { slug: 'b', name: 'b', address: null, lat: null, lon: null, city: 'warszawa' });
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
    enrichMatched24h: 0,
    enrichFailures24h: 0,
    untappdSearchHealthy: true,
    extMatchRequests: 0,
    extMatchAnon: 0,
    extMatchBeers: 0,
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

it('reports enrich health metrics', () => {
  const db = fresh();
  const { lastInsertRowid: beerId } = db.prepare(
    `INSERT INTO beers (untappd_id,name,brewery,normalized_name,normalized_brewery,untappd_lookup_at) VALUES (10,'A','B','a','b',?)`,
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT INTO enrich_failures (beer_id,brewery,name,search_url,outcome,candidates_count,candidates_summary,fail_count,last_at) VALUES (?,'B','A','u','not_found',0,'',1,?)`,
  ).run(beerId, new Date().toISOString());
  setJobState(db, 'untappd_search_canary', JSON.stringify({ ok: true, at: new Date().toISOString() }));
  const m = collectStatus(db, new Date());
  expect(m.enrichMatched24h).toBe(1);
  expect(m.enrichFailures24h).toBe(1);
  expect(m.untappdSearchHealthy).toBe(true);
});

it('orphansPending excludes retired orphans', () => {
  const db = fresh();
  const { lastInsertRowid: a } = db.prepare(
    `INSERT INTO beers (untappd_id,name,brewery,normalized_name,normalized_brewery) VALUES (NULL,'Alpha','Brew A','alpha','brew a')`,
  ).run();
  db.prepare(
    `INSERT INTO beers (untappd_id,name,brewery,normalized_name,normalized_brewery) VALUES (NULL,'Beta','Brew B','beta','brew b')`,
  ).run();
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id,brewery,name,search_url,outcome,candidates_count,candidates_summary,
        fail_count,last_at,source_url,review_class,retired_at)
     VALUES (?,'Brew A','Alpha','u','not_found',0,'',1,'2026-07-01T00:00:00Z','','parser_bug','2026-07-19T00:00:00Z')`,
  ).run(a);
  const m = collectStatus(db, new Date('2026-07-19T10:00:00Z'));
  expect(m.orphansPending).toBe(1);
});

test('collectStatus: extension /match metrics come from the previous Warsaw day', () => {
  const db = openDb(':memory:');
  migrate(db);
  const now = new Date('2026-06-05T09:30:00Z');
  const yesterday = previousDate(warsawDateAndHour(now).date);
  recordMatchUsage(db, { date: yesterday, authed: false, beers: 3 });
  recordMatchUsage(db, { date: yesterday, authed: true, beers: 2 });
  // Same-day (today) row must NOT be counted.
  recordMatchUsage(db, { date: warsawDateAndHour(now).date, authed: false, beers: 99 });
  const m = collectStatus(db, now);
  expect(m.extMatchRequests).toBe(2);
  expect(m.extMatchAnon).toBe(1);
  expect(m.extMatchBeers).toBe(5);
});
