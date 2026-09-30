import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { getFestBySlug } from '../storage/fests';
import { menuFor } from '../storage/fest_menu';
import { insertVenueCheckins } from '../storage/venue_checkins';
import { BlockedPageError, ingestFeedPage, ingestMenuPage } from './fest-ingest';

const FIXTURES = join(__dirname, '../sources/untappd/__fixtures__');
const DOM = readFileSync(join(FIXTURES, 'venue-activity-dom.html'), 'utf8');
const RAW = readFileSync(join(FIXTURES, 'venue-more-feed-raw.html'), 'utf8');
const MENU = readFileSync(join(FIXTURES, 'venue-menu.html'), 'utf8');
const VENUE = 11142155;
const NOW = '2026-03-31T12:20:00.000Z';

function fresh(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const coverage = (db: DB) => db.prepare('SELECT venue_id, from_at, to_at, eye FROM fest_coverage').all();

describe('ingestFeedPage', () => {
  it('stores a head page and proves [oldest, fetchedAt]', () => {
    const db = fresh();
    const r = ingestFeedPage(db, { venueId: VENUE, html: RAW, cursor: null, fetchedAt: '2026-03-31T12:19:00.000Z', eye: 'laptop', now: NOW });
    expect(r).toEqual({ inserted: 3, seen: 3, dropped: 0, mismatched: 0, stitched: false, nextCursor: '1559318775' });
    expect(coverage(db)).toEqual([
      { venue_id: VENUE, from_at: '2026-03-31T12:12:08.000Z', to_at: '2026-03-31T12:19:00.000Z', eye: 'laptop' },
    ]);
    expect(db.prepare('SELECT checkin_id, bid, untappd_user, checkin_at FROM venue_checkins ORDER BY checkin_id DESC').all()).toEqual([
      { checkin_id: 1559318905, bid: 6604039, untappd_user: 'Bierfluenzer', checkin_at: '2026-03-31T12:14:19.000Z' },
      { checkin_id: 1559318837, bid: 6646560, untappd_user: 'Bierfluenzer', checkin_at: '2026-03-31T12:13:15.000Z' },
      { checkin_id: 1559318775, bid: 5716461, untappd_user: 'Bierfluenzer', checkin_at: '2026-03-31T12:12:08.000Z' },
    ]);
  });

  it('a repeat of the same page inserts nothing, stitches, and adds no duplicate span', () => {
    const db = fresh();
    const input = { venueId: VENUE, html: RAW, cursor: null, fetchedAt: '2026-03-31T12:19:00.000Z', eye: 'laptop' as const, now: NOW };
    ingestFeedPage(db, input);
    expect(ingestFeedPage(db, input)).toEqual({ inserted: 0, seen: 3, dropped: 0, mismatched: 0, stitched: true, nextCursor: '1559318775' });
    expect(coverage(db)).toHaveLength(1);
  });

  it('drops a date-only row and then proves no span for the page', () => {
    const db = fresh();
    const r = ingestFeedPage(db, { venueId: VENUE, html: DOM, cursor: null, fetchedAt: NOW, eye: 'laptop', now: NOW });
    expect([r.inserted, r.seen, r.dropped, r.stitched]).toEqual([2, 2, 1, false]);
    expect(coverage(db)).toEqual([]);
  });

  it('a cursor page whose cursor was never stored writes check-ins but no coverage', () => {
    const db = fresh();
    const r = ingestFeedPage(db, { venueId: VENUE, html: RAW, cursor: '1559319022', fetchedAt: NOW, eye: 'server', now: NOW });
    expect(r.inserted).toBe(3);
    expect(coverage(db)).toEqual([]);
  });

  it('a cursor stored for another venue proves nothing here', () => {
    const db = fresh();
    insertVenueCheckins(db, [{ checkin_id: 1559319022, venue_id: 2167060, bid: 1, untappd_user: null, checkin_at: '2026-03-31T12:16:16.000Z' }], 'server', NOW);
    ingestFeedPage(db, { venueId: VENUE, html: RAW, cursor: '1559319022', fetchedAt: NOW, eye: 'server', now: NOW });
    expect(coverage(db)).toEqual([]);
  });

  it('a cursor page with a stored cursor proves [oldest, cursor time] and stitches to its head page', () => {
    const db = fresh();
    insertVenueCheckins(db, [{ checkin_id: 1559319022, venue_id: VENUE, bid: 1, untappd_user: null, checkin_at: '2026-03-31T12:16:16.000Z' }], 'server', NOW);
    db.prepare(`INSERT INTO fest_coverage (venue_id, from_at, to_at, eye, recorded_at) VALUES (?, ?, ?, 'server', ?)`)
      .run(VENUE, '2026-03-31T12:16:16.000Z', '2026-03-31T12:19:00.000Z', NOW);
    const r = ingestFeedPage(db, { venueId: VENUE, html: RAW, cursor: '1559319022', fetchedAt: NOW, eye: 'server', now: NOW });
    expect(r.stitched).toBe(true);
    expect(coverage(db)).toContainEqual({ venue_id: VENUE, from_at: '2026-03-31T12:12:08.000Z', to_at: '2026-03-31T12:16:16.000Z', eye: 'server' });
  });

  it('rows of another venue are not stored and the page proves nothing', () => {
    const db = fresh();
    const r = ingestFeedPage(db, { venueId: 2167060, html: RAW, cursor: null, fetchedAt: NOW, eye: 'laptop', now: NOW });
    expect([r.inserted, r.seen, r.mismatched]).toEqual([0, 0, 3]);
    expect([db.prepare('SELECT COUNT(*) AS n FROM venue_checkins').get(), coverage(db)]).toEqual([{ n: 0 }, []]);
  });

  it('a later eye fills in an author the first eye lacked, keeping the first eye', () => {
    const db = fresh();
    insertVenueCheckins(db, [{ checkin_id: 1559318905, venue_id: VENUE, bid: 6604039, untappd_user: null, checkin_at: '2026-03-31T12:14:19.000Z' }], 'server', NOW);
    ingestFeedPage(db, { venueId: VENUE, html: RAW, cursor: null, fetchedAt: NOW, eye: 'laptop', now: NOW });
    expect(db.prepare('SELECT untappd_user, first_eye FROM venue_checkins WHERE checkin_id = 1559318905').get())
      .toEqual({ untappd_user: 'Bierfluenzer', first_eye: 'server' });
  });

  it('does not fill an author into a stored row that disagrees on the Untappd facts', () => {
    const db = fresh();
    insertVenueCheckins(db, [{ checkin_id: 1559318905, venue_id: VENUE, bid: 999, untappd_user: null, checkin_at: '2026-03-31T12:14:19.000Z' }], 'server', NOW);
    ingestFeedPage(db, { venueId: VENUE, html: RAW, cursor: null, fetchedAt: NOW, eye: 'laptop', now: NOW });
    expect(db.prepare('SELECT untappd_user FROM venue_checkins WHERE checkin_id = 1559318905').get()).toEqual({ untappd_user: null });
  });

  it('an empty page writes nothing and has no cursor', () => {
    const db = fresh();
    expect(ingestFeedPage(db, { venueId: VENUE, html: '<html></html>', cursor: null, fetchedAt: NOW, eye: 'laptop', now: NOW }))
      .toEqual({ inserted: 0, seen: 0, dropped: 0, mismatched: 0, stitched: false, nextCursor: null });
    expect(coverage(db)).toEqual([]);
  });

  it('refuses a Cloudflare page and writes nothing', () => {
    const db = fresh();
    expect(() => ingestFeedPage(db, { venueId: VENUE, html: '<title>Just a moment...</title>', cursor: null, fetchedAt: NOW, eye: 'laptop', now: NOW }))
      .toThrow(BlockedPageError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM venue_checkins').get()).toEqual({ n: 0 });
  });
});

describe('ingestMenuPage', () => {
  it('links every menu item by bid with Untappd provenance and records its section', () => {
    const db = fresh();
    const fest = getFestBySlug(db, 'wfp22')!;
    expect(ingestMenuPage(db, { festId: fest.id, html: MENU, now: NOW })).toEqual({ items: 4, updatedAt: '2026-09-29T12:15:39.465Z', stale: false });
    expect(menuFor(db, fest.id).map((m) => [m.section, m.untappd_id, m.style, m.abv, m.rating_global])).toEqual([
      ['Browar Test', 7000001, 'Sour - Fruited', 5, null],
      ['PINTA', 6852012, 'IPA - New England / Hazy', 6.5, 4.1],
      ['PINTA', 6491580, 'Stout - Imperial / Double', 10, 4.03],
      ['PINTA', 6726011, 'IPA - American', 6.1, 4.07],
    ]);
    expect(db.prepare('SELECT DISTINCT untappd_id_source FROM beers').all()).toEqual([{ untappd_id_source: 'checkin' }]);
  });

  it('does not let an older menu page roll back a newer one', () => {
    const db = fresh();
    const fest = getFestBySlug(db, 'wfp22')!;
    ingestMenuPage(db, { festId: fest.id, html: MENU, now: NOW });
    const older = MENU.replace('2026-09-29T12:15:39.465575Z', '2026-09-28T09:00:00Z').replace('Browar Test', 'Browar Moved');
    expect(ingestMenuPage(db, { festId: fest.id, html: older, now: '2026-10-01T00:00:00.000Z' }))
      .toEqual({ items: 4, updatedAt: '2026-09-28T09:00:00.000Z', stale: true });
    expect(menuFor(db, fest.id).map((m) => [m.section, m.last_seen_at]).filter(([sec]) => sec !== 'PINTA'))
      .toEqual([['Browar Test', NOW]]);
  });

  it('keeps a beer listed by two exhibitors under both sections', () => {
    const db = fresh();
    const fest = getFestBySlug(db, 'wfp22')!;
    const twice = MENU.replace('/b/browar-test-new-beer/7000001', '/b/verdant-brewing-co-beskidy/6852012');
    ingestMenuPage(db, { festId: fest.id, html: twice, now: NOW });
    expect(menuFor(db, fest.id).filter((m) => m.untappd_id === 6852012).map((m) => m.section)).toEqual(['Browar Test', 'PINTA']);
  });

  it('refuses a Cloudflare page', () => {
    const db = fresh();
    expect(() => ingestMenuPage(db, { festId: 1, html: '<title>Just a moment...</title>', now: NOW })).toThrow(BlockedPageError);
  });
});
