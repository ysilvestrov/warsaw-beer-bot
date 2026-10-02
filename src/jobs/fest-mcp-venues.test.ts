import pino from 'pino';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { getJobState, setJobState } from '../storage/job_state';
import { createPersistentCircuitBreaker } from '../domain/untappd-circuit';
import type { FestMcp, ToolCallResult } from '../sources/untappd/mcp-client';
import { runFestMcpVenues, venueAttemptKey, venueCursorKey, venueLastKey } from './fest-mcp-venues';

// WFP22 seed: session 1 is 2026-10-15 14:00–22:00 UTC, so the first read reaches back to 13:00.
const FEST = 11142155;
const KONF = 2815864;
const STADIUM = 2167060;
const IN_SESSION = new Date('2026-10-15T18:00:00.000Z');
const minutesLater = (m: number) => new Date(IN_SESSION.getTime() + m * 60 * 1000);

/** A check-in at `venue`, `minutesAgo` before IN_SESSION. */
const rec = (id: number, venue: number, minutesAgo: number) => ({
  checkin_id: id,
  created_at: new Date(IN_SESSION.getTime() - minutesAgo * 60 * 1000).toUTCString().replace('GMT', '+0000'),
  rating_score: 4, user: { user_name: 'someone' },
  beer: { bid: 6000011, beer_name: 'Bravo', beer_style: 'IPA - American', beer_abv: 6.5 },
  brewery: { brewery_name: 'Brew' }, venue: { venue_id: venue },
});
const page = (records: unknown[], mem: boolean = false): ToolCallResult =>
  ({ content: [{ type: 'text', text: JSON.stringify({ mem, checkins: { items: records } }) }] });
/** 25 check-ins at `venue`, ids top..top-24, one minute apart starting `minutesAgo`. */
const fullPage = (venue: number, top: number, minutesAgo: number) =>
  page(Array.from({ length: 25 }, (_, i) => rec(top - i, venue, minutesAgo + i)));

function setup(answers: Record<number, (ToolCallResult | Error)[]>) {
  const db: DB = openDb(':memory:');
  migrate(db);
  const calls: Record<string, unknown>[] = [];
  const mcp: FestMcp = {
    async call(tool, args) {
      if (tool !== 'get_venue_checkins') throw new Error(`unexpected ${tool}`);
      calls.push(args);
      const next = answers[args.venueId as number]?.shift();
      if (next === undefined) throw new Error(`unexpected read of ${String(args.venueId)}`);
      if (next instanceof Error) throw next;
      return next;
    },
    owner: () => null,
    close: async () => {},
  };
  const breaker = createPersistentCircuitBreaker({ db, key: 'fest_mcp_open_until', cooldownMs: 30 * 60 * 1000, blockThreshold: 2, onTrip: () => {}, onRecover: () => {} });
  return { db, calls, deps: { db, log: pino({ level: 'silent' }), mcp, breaker } };
}

const coverage = (db: DB, venue: number) =>
  db.prepare('SELECT from_at, to_at FROM fest_coverage WHERE venue_id = ? AND eye = ? ORDER BY from_at').all(venue, 'mcp_venue');

describe('runFestMcpVenues', () => {
  it('outside a polling window reads nothing', async () => {
    const { deps, calls } = setup({});
    expect(await runFestMcpVenues(deps, new Date('2026-10-14T18:00:00.000Z'))).toBe(null);
    expect(calls).toEqual([]);
  });

  it('the first tick reads all three venues, the festival venue first, from the head and proves each page up to now', async () => {
    const { db, deps, calls } = setup({
      [FEST]: [page([rec(103, FEST, 2), rec(102, FEST, 10)])],
      [KONF]: [page([rec(203, KONF, 30)])],
      [STADIUM]: [page([])],
    });
    expect(await runFestMcpVenues(deps, IN_SESSION)).toBe(3);
    expect(calls).toEqual([
      { venueId: FEST, limit: 25 }, { venueId: STADIUM, limit: 25 }, { venueId: KONF, limit: 25 },
    ]);
    expect([coverage(db, FEST), coverage(db, STADIUM)]).toEqual([
      [{ from_at: '2026-10-15T17:50:00.000Z', to_at: '2026-10-15T18:00:00.000Z' }],
      [],
    ]);
    expect([getJobState(db, venueCursorKey(FEST)), getJobState(db, venueCursorKey(KONF)), getJobState(db, venueCursorKey(STADIUM))])
      .toEqual(['103', '203', null]);
  });

  it('three minutes later reads only the festival venue; six minutes later all three', async () => {
    const { deps, calls } = setup({
      [FEST]: [page([]), page([]), page([])],
      [KONF]: [page([]), page([])],
      [STADIUM]: [page([]), page([])],
    });
    await runFestMcpVenues(deps, IN_SESSION);
    await runFestMcpVenues(deps, minutesLater(3));
    const afterThree = calls.length;
    await runFestMcpVenues(deps, minutesLater(6));
    expect([afterThree, calls.slice(afterThree).map((a) => a.venueId)]).toEqual([4, [FEST, STADIUM, KONF]]);
  });

  it('without a cursor pages down with maxId until a page reaches an hour before the session start', async () => {
    // 13:00 is 300 minutes before 18:00: the second page (from 290 min ago) crosses it.
    const { db, deps, calls } = setup({
      [FEST]: [fullPage(FEST, 1050, 265), fullPage(FEST, 1025, 290)],
      [KONF]: [page([])], [STADIUM]: [page([])],
    });
    await runFestMcpVenues(deps, IN_SESSION);
    expect(calls.slice(0, 2)).toEqual([{ venueId: FEST, limit: 25 }, { venueId: FEST, limit: 25, maxId: 1026 }]);
    expect(coverage(db, FEST)).toEqual([
      { from_at: '2026-10-15T12:46:00.000Z', to_at: '2026-10-15T13:11:00.000Z' },
      { from_at: '2026-10-15T13:11:00.000Z', to_at: '2026-10-15T18:00:00.000Z' },
    ]);
  });

  it('with a cursor stops at the page that holds it', async () => {
    const { deps, db, calls } = setup({ [FEST]: [fullPage(FEST, 1050, 0), fullPage(FEST, 1025, 25)], [KONF]: [page([])], [STADIUM]: [page([])] });
    setJobState(db, venueCursorKey(FEST), '1010');
    await runFestMcpVenues(deps, IN_SESSION);
    expect([calls.filter((a) => a.venueId === FEST).length, getJobState(db, venueCursorKey(FEST))]).toEqual([2, '1050']);
  });

  it('a page Untappd served from its cache stores its check-ins but proves no coverage', async () => {
    const { db, deps } = setup({ [FEST]: [page([rec(103, FEST, 2)], true)], [KONF]: [page([])], [STADIUM]: [page([])] });
    await runFestMcpVenues(deps, IN_SESSION);
    expect([db.prepare('SELECT checkin_id, first_eye FROM venue_checkins').all(), coverage(db, FEST)])
      .toEqual([[{ checkin_id: 103, first_eye: 'mcp_venue' }], []]);
  });

  it('a failing venue keeps its cursor, the others are still read, and the breaker hears of it', async () => {
    const { db, deps } = setup({ [FEST]: [new Error('mcp down')], [KONF]: [page([rec(203, KONF, 1)])], [STADIUM]: [page([])] });
    setJobState(db, venueCursorKey(FEST), '100');
    expect(await runFestMcpVenues(deps, IN_SESSION)).toBe(1);
    expect([
      getJobState(db, venueCursorKey(FEST)), getJobState(db, venueLastKey(FEST)), getJobState(db, venueAttemptKey(FEST)),
      getJobState(db, venueCursorKey(KONF)), getJobState(db, 'fest_mcp_open_until'),
    ]).toEqual(['100', null, '2026-10-15T18:00:00.000Z', '203', null]);
  });

  it('a failing venue is retried at its cadence, not on the next minute', async () => {
    const { deps, calls } = setup({ [FEST]: [new Error('mcp down'), page([])], [KONF]: [page([])], [STADIUM]: [page([])] });
    await runFestMcpVenues(deps, IN_SESSION);
    await runFestMcpVenues(deps, minutesLater(1));
    const afterOne = calls.length;
    await runFestMcpVenues(deps, minutesLater(3));
    expect([afterOne, calls.slice(afterOne)]).toEqual([3, [{ venueId: FEST, limit: 25 }]]);
  });

  it('two failing reads in a row trip the shared breaker for 30 minutes', async () => {
    const { db, deps } = setup({ [FEST]: [new Error('mcp down'), new Error('mcp down')], [KONF]: [new Error('mcp down')], [STADIUM]: [new Error('mcp down')] });
    await runFestMcpVenues(deps, IN_SESSION);
    await runFestMcpVenues(deps, minutesLater(3));
    expect(getJobState(db, 'fest_mcp_open_until')).toBe('2026-10-15T18:33:00.000Z');
  });

  it('a tick with no venue due leaves the shared breaker alone: a friend-feed failure still counts', async () => {
    const { db, deps } = setup({ [FEST]: [page([])], [KONF]: [page([])], [STADIUM]: [page([])] });
    await runFestMcpVenues(deps, IN_SESSION);
    deps.breaker.onResult(true, minutesLater(1)); // the friend feed fails
    await runFestMcpVenues(deps, minutesLater(1)); // nothing due
    deps.breaker.onResult(true, minutesLater(2)); // and fails again
    expect(getJobState(db, 'fest_mcp_open_until')).toBe('2026-10-15T18:32:00.000Z');
  });

  it('after four full pages above the cursor the rest is a hole: the cursor still moves to the newest', async () => {
    const { db, deps, calls } = setup({
      [FEST]: [fullPage(FEST, 1100, 0), fullPage(FEST, 1075, 25), fullPage(FEST, 1050, 50), fullPage(FEST, 1025, 75)],
      [KONF]: [page([])], [STADIUM]: [page([])],
    });
    setJobState(db, venueCursorKey(FEST), '900');
    await runFestMcpVenues(deps, IN_SESSION);
    expect([calls.filter((a) => a.venueId === FEST).length, getJobState(db, venueCursorKey(FEST))]).toEqual([4, '1100']);
  });

  it('an open breaker reads nothing', async () => {
    const { db, deps, calls } = setup({});
    setJobState(db, 'fest_mcp_open_until', '2026-10-15T18:30:00.000Z');
    expect(await runFestMcpVenues(deps, IN_SESSION)).toBe(null);
    expect(calls).toEqual([]);
  });
});
