import { openDb } from './db';
import { migrate } from './schema';
import { upsertPub } from './pubs';
import { upsertBeer } from './beers';
import { createSnapshot, insertTaps } from './snapshots';
import { collectStatus } from './stats';
import { setJobState } from './job_state';
import { recordMatchUsage } from './api_usage';
import { upsertMatch } from './match_links';
import { recordEnrichFailure, setEnrichFailureReview, retireEnrichFailure } from './enrich_failures';
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
    orphansRelayQueue: 1,   // orphan 'C' із seed() не має рядка в match_links
    // #421: seed() has no locked or unlocked rows, so all three read 0 here. The audit's
    // own behaviour is pinned by the dedicated test below, not by this shape assertion.
    lockedRows: 0,
    unlocked7d: 0,
    verdictsOutlived7d: 0,
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
    sealUnidentifiable: 0,
    sealUnidentifiableReobserved: 0,
    sealNotABeer: 0,
    sealNotABeer7d: 0,
    sealRetiredFalsified: 0,
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

it('orphansRelayQueue counts orphans not on a tap right now, minus not_a_beer/retired', () => {
  const db = fresh();
  // 1) relay-orphan без лінка → рахується
  upsertBeer(db, {
    name: 'Barrel Pie', brewery: 'The Bruery', style: null, abv: null, rating_global: null,
    normalized_name: 'barrel pie', normalized_brewery: 'the bruery',
  });
  // 2) relay-orphan, протриажений як not_a_beer → НЕ рахується
  const notABeer = upsertBeer(db, {
    name: 'Kelih Fino 545', brewery: 'Stoelzle', style: null, abv: null, rating_global: null,
    normalized_name: 'kelih fino 545', normalized_brewery: 'stoelzle',
  });
  recordEnrichFailure(db, {
    beer_id: notABeer, brewery: 'Stoelzle', name: 'Kelih Fino 545',
    search_url: '', source_url: '', outcome: 'not_found',
    candidates_count: 0, candidates_summary: '', at: '2026-06-04T11:00:00Z',
  });
  setEnrichFailureReview(db, notABeer, 'not_a_beer', null, '2026-06-04T11:30:00Z');
  // 3) orphan on a latest-snapshot tap (on-tap пул) → НЕ рахується в relay-пулі:
  // #486 зробив relay-предикат буквальним запереченням on-tap предиката, тож
  // рядок з лінком, що досягає крана на ОСТАННЬОМУ снапшоті паба, тепер належить
  // on-tap пулу, а не «нікому» — крон його й так бачить.
  const linked = upsertBeer(db, {
    name: 'Clementine', brewery: 'Magic Road', style: null, abv: null, rating_global: null,
    normalized_name: 'clementine', normalized_brewery: 'magic road',
  });
  const ref = 'Magic Road Clementine';
  upsertMatch(db, ref, linked, 1.0);
  const linkedPub = upsertPub(db, {
    slug: 'linked-pub', name: 'Linked Pub', address: null, lat: null, lon: null, city: 'warszawa',
  });
  const linkedSnap = createSnapshot(db, linkedPub, '2026-06-04T10:00:00Z');
  insertTaps(db, linkedSnap, [tap(ref)]);

  const m = collectStatus(db, new Date('2026-06-04T12:00:00Z'));
  expect(m.orphansRelayQueue).toBe(1);
});

// #421. Red if the lock clause is folded into `orphanNotOnTapPredicate` itself
// instead of being appended at the two pool call sites. This metric counts the whole drain
// QUEUE, not the slice eligible to run right now — which is exactly why it already skips
// the backoff filter. Hiding locked rows here would make the backlog look like it shrank
// when it only went quiet, and the lock's own audit counter is what reports that number.
it('orphansRelayQueue still counts a row that is locked out of the pools', () => {
  const db = fresh();
  const locked = upsertBeer(db, {
    name: 'Bitter Cost', brewery: 'Mad Brew', style: null, abv: null, rating_global: null,
    normalized_name: 'bitter cost', normalized_brewery: 'mad brew',
  });
  recordEnrichFailure(db, {
    beer_id: locked, brewery: 'Mad Brew', name: 'Bitter Cost',
    search_url: '', source_url: '', outcome: 'not_found',
    candidates_count: 3, candidates_summary: '', at: '2026-06-04T11:00:00Z',
  });
  setEnrichFailureReview(db, locked, 'matcher_bug', 'alias gap', '2026-06-04T11:30:00Z', 347);

  const m = collectStatus(db, new Date('2026-06-04T12:00:00Z'));
  expect(m.orphansRelayQueue).toBe(1);
});

// #377 part B: the seal audit. Each number falsifies a different premise — see the
// StatusMetrics comment. Dropping the `b.untappd_lookup_at > ef.reviewed_at` clause
// makes the re-observed count equal the total and turns this red.
it('counts the seals, the re-observed subset and the falsified retirements', () => {
  const db = fresh();
  const seedOrphan = (name: string): number => upsertBeer(db, {
    name, brewery: 'B', style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: 'b',
  });
  const seedFailure = (id: number, at: string): void => recordEnrichFailure(db, {
    beer_id: id, brewery: 'B', name: 'n', search_url: '', source_url: '',
    outcome: 'not_found', candidates_count: 0, candidates_summary: '', at,
  });

  // unidentifiable, looked up AFTER its verdict → re-observed
  const seen = seedOrphan('Seen');
  seedFailure(seen, '2026-08-01T00:00:00.000Z');
  setEnrichFailureReview(db, seen, 'unidentifiable', null, '2026-08-01T00:00:00.000Z');
  db.prepare('UPDATE beers SET untappd_lookup_at = ? WHERE id = ?')
    .run('2026-08-10T00:00:00.000Z', seen);

  // unidentifiable, last looked up BEFORE its verdict → counted in the total only
  const unseen = seedOrphan('Unseen');
  seedFailure(unseen, '2026-08-01T00:00:00.000Z');
  setEnrichFailureReview(db, unseen, 'unidentifiable', null, '2026-08-01T00:00:00.000Z');
  db.prepare('UPDATE beers SET untappd_lookup_at = ? WHERE id = ?')
    .run('2026-07-01T00:00:00.000Z', unseen);

  const freshMerch = seedOrphan('Surprise Box');
  seedFailure(freshMerch, '2026-08-14T00:00:00.000Z');
  setEnrichFailureReview(db, freshMerch, 'not_a_beer', null, '2026-08-14T00:00:00.000Z');

  const oldMerch = seedOrphan('T-shirt');
  seedFailure(oldMerch, '2026-06-01T00:00:00.000Z');
  setEnrichFailureReview(db, oldMerch, 'not_a_beer', null, '2026-06-01T00:00:00.000Z');

  // retired, yet the beer is still an orphan — falsified by its own existence
  const retired = seedOrphan('Retired');
  seedFailure(retired, '2026-07-01T00:00:00.000Z');
  setEnrichFailureReview(db, retired, 'matcher_bug', null, '2026-07-01T00:00:00.000Z');
  retireEnrichFailure(db, retired, 'fix shipped', '2026-07-02T00:00:00.000Z');

  const m = collectStatus(db, new Date('2026-08-15T12:00:00.000Z'));
  expect(m.sealUnidentifiable).toBe(2);
  expect(m.sealUnidentifiableReobserved).toBe(1);
  expect(m.sealNotABeer).toBe(2);
  expect(m.sealNotABeer7d).toBe(1);
  expect(m.sealRetiredFalsified).toBe(1);
});

// #421 audit. Red if any of the three counters is dropped or mis-scoped. Each falsifies a
// different premise: lockedRows is the quota the lock saves; unlocked7d at zero across a
// week in which issues closed means the mechanism is dead; verdictsOutlived7d near the
// unlock count means our fixes never cover the rows that motivated them.
it('counts locked rows, in-flight unlocks and verdicts outlived by their fix', () => {
  const db = fresh();
  const mk = (name: string) => upsertBeer(db, {
    untappd_id: null, name, brewery: 'Mad Brew', style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: 'mad brew',
  });
  const fail = (id: number, name: string, at: string) => recordEnrichFailure(db, {
    beer_id: id, brewery: 'Mad Brew', name, search_url: '', source_url: '',
    outcome: 'not_found', candidates_count: 3, candidates_summary: '', at,
  });

  // 1) locked: actionable verdict, an issue, free retry not yet spent.
  const locked = mk('Bitter Cost');
  fail(locked, 'Bitter Cost', '2026-08-10T00:00:00Z');
  setEnrichFailureReview(db, locked, 'matcher_bug', 'alias gap', '2026-08-10T01:00:00Z', 347);

  // 2) unlocked and still in flight: beat 1 fired, beat 2 has not.
  const inFlight = mk('Charred Memory');
  fail(inFlight, 'Charred Memory', '2026-08-14T00:00:00Z');
  setEnrichFailureReview(db, inFlight, 'parser_bug', 'split', '2026-08-14T01:00:00Z', 376);
  db.prepare('UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?')
    .run('2026-08-14T02:00:00Z', inFlight);

  // 3) verdict outlived its fix: beat 2 cleared the class, issue_number is the residue.
  const outlived = mk('Siesta');
  fail(outlived, 'Siesta', '2026-08-15T00:00:00Z');
  db.prepare('UPDATE enrich_failures SET issue_number = 254 WHERE beer_id = ?').run(outlived);

  // 4) a verdict with no issue is not locked — nothing could ever unlock it.
  const legacy = mk('Legacy Row');
  fail(legacy, 'Legacy Row', '2026-08-10T00:00:00Z');
  setEnrichFailureReview(db, legacy, 'matcher_bug', 'no issue', '2026-08-10T01:00:00Z', null);

  const m = collectStatus(db, new Date('2026-08-16T12:00:00Z'));
  expect(m.lockedRows).toBe(1);
  expect(m.unlocked7d).toBe(1);
  expect(m.verdictsOutlived7d).toBe(1);
});

// #421. Red if `retired_at IS NULL` is dropped from the lockedRows metric. A retired row
// keeps its review_class for audit, but it is held out of the pools by retired_at, not by
// the lock — counting it as lock-saved quota overstates what the lock buys and hides the
// retired-orphan debt that sealRetiredFalsified exists to report.
it('lockedRows does not count a retired row that kept its actionable verdict', () => {
  const db = fresh();
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Bitter Cost', brewery: 'Mad Brew',
    style: null, abv: null, rating_global: null,
    normalized_name: 'bitter cost', normalized_brewery: 'mad brew',
  });
  recordEnrichFailure(db, {
    beer_id: id, brewery: 'Mad Brew', name: 'Bitter Cost', search_url: '', source_url: '',
    outcome: 'not_found', candidates_count: 3, candidates_summary: '', at: '2026-08-10T00:00:00Z',
  });
  setEnrichFailureReview(db, id, 'matcher_bug', 'alias gap', '2026-08-10T01:00:00Z', 347);
  expect(retireEnrichFailure(db, id, 'resolved by a shipped fix', '2026-08-11T00:00:00Z')).toBe(true);

  expect(collectStatus(db, new Date('2026-08-16T12:00:00Z')).lockedRows).toBe(0);
});
