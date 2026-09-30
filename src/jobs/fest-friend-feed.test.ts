import pino from 'pino';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile, setUntappdUsername } from '../storage/user_profiles';
import { getFestBySlug } from '../storage/fests';
import { addMember, createTeam } from '../storage/fest_teams';
import { getJobState, setJobState } from '../storage/job_state';
import { createPersistentCircuitBreaker } from '../domain/untappd-circuit';
import type { FestMcp, ToolCallResult } from '../sources/untappd/mcp-client';
import { FRIEND_CURSOR_KEY, OWNER_CURSOR_KEY, runFestFriendFeed, runFestMcpKeepalive } from './fest-friend-feed';

const IN_SESSION = new Date('2026-10-15T18:00:00.000Z');
const STADIUM = 2167060;

const record = (id: number, user: string, venueId: number | null, bid = 6000011) => ({
  checkin_id: id, created_at: 'Thu, 15 Oct 2026 17:55:00 +0000', rating_score: 4,
  user: { user_name: user }, beer: { bid, beer_name: 'Bravo', beer_style: 'IPA - American', beer_abv: 6.5 },
  brewery: { brewery_name: 'Brew' }, venue: venueId === null ? [] : { venue_id: venueId },
});
const page = (records: unknown[]): ToolCallResult => ({ content: [{ type: 'text', text: JSON.stringify({ checkins: { items: records } }) }] });

function setup(answers: Record<string, (ToolCallResult | Error)[]>, owner: string | null = 'ownerName') {
  const db: DB = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  ensureProfile(db, 1);
  setUntappdUsername(db, 1, 'Member1');
  addMember(db, createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z').id, 1, 'M1', '2026-10-01T00:00:00.000Z');
  const calls: [string, Record<string, unknown>][] = [];
  const mcp: FestMcp = {
    async call(tool, args) {
      calls.push([tool, args]);
      const next = answers[tool]?.shift();
      if (next === undefined) throw new Error(`unexpected ${tool}`);
      if (next instanceof Error) throw next;
      return next;
    },
    owner: () => owner,
    close: async () => {},
  };
  const alerts: string[] = [];
  const breaker = createPersistentCircuitBreaker({ db, key: 'fest_mcp_open_until', cooldownMs: 30 * 60 * 1000, blockThreshold: 2, onTrip: () => {}, onRecover: () => {} });
  const deps = { db, log: pino({ level: 'silent' }), mcp, breaker, notifyAdmin: async (m: string) => { alerts.push(m); } };
  return { db, deps, calls, alerts };
}

describe('runFestFriendFeed', () => {
  it("a member's check-in at the stadium is a venue check-in with its author and a check-in in the member's history", async () => {
    const { db, deps } = setup({ get_my_friend_feed: [page([record(501, 'member1', STADIUM)])], get_user_checkins: [page([])] });
    await runFestFriendFeed(deps, IN_SESSION);
    expect([
      db.prepare('SELECT checkin_id, venue_id, bid, untappd_user, first_eye FROM venue_checkins').all(),
      db.prepare('SELECT checkin_id, telegram_id, account_key, checkin_at FROM checkins').all(),
    ]).toEqual([
      [{ checkin_id: 501, venue_id: STADIUM, bid: 6000011, untappd_user: 'member1', first_eye: 'friend_feed' }],
      [{ checkin_id: '501', telegram_id: 1, account_key: 'member1', checkin_at: '2026-10-15 17:55:00' }],
    ]);
  });

  it("another friend's check-in at the stadium is only a venue check-in; a member at home is only history", async () => {
    const { db, deps } = setup({ get_my_friend_feed: [page([record(502, 'stranger', STADIUM), record(503, 'Member1', null, 6000012)])], get_user_checkins: [page([])] });
    await runFestFriendFeed(deps, IN_SESSION);
    expect([
      db.prepare('SELECT checkin_id FROM venue_checkins').all(),
      db.prepare('SELECT checkin_id FROM checkins').all(),
    ]).toEqual([[{ checkin_id: 502 }], [{ checkin_id: '503' }]]);
  });

  it('reads the owner by name, stores both cursors, and asks for newer than them on the next tick', async () => {
    const { db, deps, calls } = setup({
      get_my_friend_feed: [page([record(510, 'x', null)]), page([])],
      get_user_checkins: [page([record(520, 'ownerName', null)]), page([])],
    });
    await runFestFriendFeed(deps, IN_SESSION);
    await runFestFriendFeed(deps, new Date(IN_SESSION.getTime() + 5 * 60 * 1000));
    expect([calls, getJobState(db, FRIEND_CURSOR_KEY), getJobState(db, OWNER_CURSOR_KEY)]).toEqual([[
      ['get_my_friend_feed', { limit: 25 }],
      ['get_user_checkins', { username: 'ownerName', limit: 25 }],
      ['get_my_friend_feed', { limit: 25, minId: 510 }],
      ['get_user_checkins', { username: 'ownerName', limit: 25, minId: 520 }],
    ], '510', '520']);
  });

  it('a full page is paged back with maxId under the same minId', async () => {
    const full = Array.from({ length: 25 }, (_, i) => record(1100 - i, 'x', null));
    const { db, deps, calls } = setup({ get_my_friend_feed: [page(full), page([record(1050, 'x', null)])], get_user_checkins: [page([])] });
    setJobState(db, FRIEND_CURSOR_KEY, '1000');
    await runFestFriendFeed(deps, IN_SESSION);
    expect([calls.slice(0, 2), getJobState(db, FRIEND_CURSOR_KEY)]).toEqual([[
      ['get_my_friend_feed', { limit: 25, minId: 1000 }],
      ['get_my_friend_feed', { limit: 25, minId: 1000, maxId: 1076 }],
    ], '1100']);
  });

  it('a rejected token opens the breaker after two ticks and alerts the admin once', async () => {
    const { db, deps, alerts } = setup({ get_my_friend_feed: [new UnauthorizedError('401'), new UnauthorizedError('401')] });
    await runFestFriendFeed(deps, IN_SESSION);
    await runFestFriendFeed(deps, new Date(IN_SESSION.getTime() + 5 * 60 * 1000));
    expect([alerts.length, getJobState(db, 'fest_mcp_open_until')]).toEqual([1, new Date(IN_SESSION.getTime() + 35 * 60 * 1000).toISOString()]);
  });

  it('outside a polling window and before its 5 minutes it calls nothing', async () => {
    const { deps, calls } = setup({ get_my_friend_feed: [page([])], get_user_checkins: [page([])] });
    await runFestFriendFeed(deps, new Date('2026-10-16T02:00:00.000Z'));
    await runFestFriendFeed(deps, IN_SESSION);
    await runFestFriendFeed(deps, new Date(IN_SESSION.getTime() + 4 * 60 * 1000));
    expect(calls.length).toBe(2);
  });
});

describe('runFestMcpKeepalive', () => {
  it('once a day: a success is quiet and the next call waits a day', async () => {
    const { deps, alerts, calls } = setup({ get_untappd_api_usage: [{ content: [{ type: 'text', text: '{}' }] }] });
    const r = [await runFestMcpKeepalive(deps, IN_SESSION), await runFestMcpKeepalive(deps, new Date(IN_SESSION.getTime() + 23 * 60 * 60 * 1000))];
    expect([r, alerts, calls.length]).toEqual([['ok', null], [], 1]);
  });

  it('a failure alerts at once and is retried an hour later, not a day later', async () => {
    const { deps, alerts } = setup({ get_untappd_api_usage: [new UnauthorizedError('401'), { content: [] }] });
    const r = [
      await runFestMcpKeepalive(deps, IN_SESSION),
      await runFestMcpKeepalive(deps, new Date(IN_SESSION.getTime() + 59 * 60 * 1000)),
      await runFestMcpKeepalive(deps, new Date(IN_SESSION.getTime() + 60 * 60 * 1000)),
    ];
    expect([r, alerts.length]).toEqual([['failed', null, 'ok'], 1]);
  });
});
