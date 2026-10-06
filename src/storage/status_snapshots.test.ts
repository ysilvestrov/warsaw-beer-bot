import { openDb } from './db';
import { migrate } from './schema';
import { listStatusSnapshots, pruneStatusSnapshots, saveStatusSnapshot, STATUS_SNAPSHOT_VERSION } from './status_snapshots';
import type { Evaluation, SnapshotMetrics } from '../domain/status/types';

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// Only the fields the assertions read differ between days; the rest is a fixed valid shape.
const metrics = (orphansPending: number): SnapshotMetrics => ({
  lastScrapeHoursAgo: 6.9, pubsScraped24h: 115, beersTotal: 30_000, beersMatched: 25_000,
  orphansPending, orphansRelayQueue: 900, ratingsMissing: 100, ratingsChecked30d: 20_000,
  snapshots: 2_000, taps: 50_000, dbSizeMb: 300, usersTotal: 10, usersLinked: 6,
  onTapDistinct: 900, onTapPubs: 110, newOnTap24h: 30, enrichMatched24h: 10, enrichFailures24h: 20,
  untappdSearchHealthy: true, extMatchRequests: 3, extMatchAnon: 1, extMatchBeers: 200,
  mcpMatchRequests: 0, mcpMatchBeers: 0, sealUnidentifiable: 50, sealUnidentifiableReobserved: 10,
  sealNotABeer: 30, sealNotABeer7d: 1, sealRetiredFalsified: 2, lockedRows: 40, unlocked7d: 1,
  verdictsOutlived7d: 0, unrescuedRows: 3, unlockedUnadjudicated7d: 0,
  diskBytesAvailable: 34_750_201_856, inodesFree: 2_078_442,
});
const colours: Evaluation[] = [{ subsystem: 'taps', colour: 'yellow', reasons: ['останній скрейп 15 год тому'] }];

test('migration v45 records its version', () => {
  const db = emptyDb();
  expect(db.prepare('SELECT version FROM schema_version WHERE version = 45').get()).toEqual({ version: 45 });
});

test('a saved snapshot round-trips its metrics and stores colours and version', () => {
  const db = emptyDb();
  saveStatusSnapshot(db, { date: '2026-10-05', metrics: metrics(412), colours, createdAt: '2026-10-05T07:00:01.000Z' });
  expect(listStatusSnapshots(db, '2026-10-05', '2026-10-06')).toEqual([{ date: '2026-10-05', metrics: metrics(412) }]);
  expect(db.prepare('SELECT version, colours_json, created_at FROM status_snapshots').get()).toEqual({
    version: STATUS_SNAPSHOT_VERSION, colours_json: JSON.stringify(colours), created_at: '2026-10-05T07:00:01.000Z',
  });
});

test('saving the same date twice keeps one row with the later content', () => {
  const db = emptyDb();
  saveStatusSnapshot(db, { date: '2026-10-05', metrics: metrics(412), colours, createdAt: '2026-10-05T07:00:01.000Z' });
  saveStatusSnapshot(db, { date: '2026-10-05', metrics: metrics(431), colours: [], createdAt: '2026-10-05T07:15:01.000Z' });
  expect(listStatusSnapshots(db, '2026-10-01', '2026-10-09')).toEqual([{ date: '2026-10-05', metrics: metrics(431) }]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM status_snapshots').get()).toEqual({ n: 1 });
});

test('list is inclusive of fromDate, exclusive of beforeDate, oldest first', () => {
  const db = emptyDb();
  for (const [date, n] of [['2026-10-02', 2], ['2026-10-03', 3], ['2026-10-04', 4], ['2026-10-05', 5]] as const) {
    saveStatusSnapshot(db, { date, metrics: metrics(n), colours: [], createdAt: `${date}T07:00:00.000Z` });
  }
  expect(listStatusSnapshots(db, '2026-10-03', '2026-10-05').map((s) => s.date)).toEqual(['2026-10-03', '2026-10-04']);
});

test('list skips rows written by another snapshot version and rows with unreadable JSON', () => {
  const db = emptyDb();
  saveStatusSnapshot(db, { date: '2026-10-03', metrics: metrics(3), colours: [], createdAt: '2026-10-03T07:00:00.000Z' });
  db.prepare(`INSERT INTO status_snapshots VALUES ('2026-10-04', 99, '{}', '[]', '2026-10-04T07:00:00.000Z')`).run();
  db.prepare(`INSERT INTO status_snapshots VALUES ('2026-10-05', ?, '{', '[]', '2026-10-05T07:00:00.000Z')`).run(STATUS_SNAPSHOT_VERSION);
  db.prepare(`INSERT INTO status_snapshots VALUES ('2026-10-06', ?, 'null', '[]', '2026-10-06T07:00:00.000Z')`).run(STATUS_SNAPSHOT_VERSION);
  db.prepare(`INSERT INTO status_snapshots VALUES ('2026-10-07', ?, '"x"', '[]', '2026-10-07T07:00:00.000Z')`).run(STATUS_SNAPSHOT_VERSION);
  db.prepare(`INSERT INTO status_snapshots VALUES ('2026-10-08', ?, '[1]', '[]', '2026-10-08T07:00:00.000Z')`).run(STATUS_SNAPSHOT_VERSION);
  expect(listStatusSnapshots(db, '2026-10-01', '2026-10-09').map((s) => s.date)).toEqual(['2026-10-03']);
});

test('prune deletes strictly older rows and reports how many', () => {
  const db = emptyDb();
  for (const date of ['2026-07-07', '2026-07-08', '2026-07-09']) {
    saveStatusSnapshot(db, { date, metrics: metrics(1), colours: [], createdAt: `${date}T07:00:00.000Z` });
  }
  expect(pruneStatusSnapshots(db, '2026-07-08')).toBe(1);
  expect(listStatusSnapshots(db, '2026-01-01', '2027-01-01').map((s) => s.date)).toEqual(['2026-07-08', '2026-07-09']);
});
