import type pino from 'pino';
import type { DB } from '../storage/db';
import { activeFests, festVenues } from '../storage/fests';
import { festMembersByUsername } from '../storage/fest_teams';
import { getJobState, setJobState } from '../storage/job_state';
import { insertVenueCheckins } from '../storage/venue_checkins';
import { upsertBeerByBid } from '../storage/beers';
import { mergeCheckin } from '../storage/checkins';
import { getHistoryOwner } from '../storage/history-owner';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import type { CircuitBreaker } from '../domain/untappd-circuit';
import { MCP_PAGE_CAP, nextCursor, pageStep } from '../domain/fest/mcp-paging';
import { parseMcpCheckins, type McpCheckin } from '../sources/untappd/mcp-checkins';
import { isMcpAuthError, type FestMcp } from '../sources/untappd/mcp-client';
import { sendThrottledAlert } from './alert-slot';

// Team check-ins through the Untappd MCP (spec §4.5): the owner's friend feed and the owner's own
// feed, every 5 minutes in a polling window. A check-in at a festival venue is a venue check-in
// (third eye, author known); a check-in by a team member goes into that member's history, which is
// what closes queue items (§6.4) — wherever it was made. No coverage is written: a friend feed is
// not the venue's whole feed.

export const FRIEND_FEED_EVERY_MS = 5 * 60 * 1000;
export const FRIEND_FEED_LAST_KEY = 'fest_friend_feed_last_at';
export const FRIEND_CURSOR_KEY = 'fest_friend_feed_min_id';
export const OWNER_CURSOR_KEY = 'fest_owner_feed_min_id';
const LOGIN_ALERT_KEY = 'fest_mcp_login_alert_at';
const HOLE_ALERT_KEY = 'fest_mcp_hole_alert_at';
const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

export interface FestFriendFeedDeps {
  db: DB;
  log: pino.Logger;
  mcp: FestMcp;
  /** Its own job_state key: an MCP outage never gates the HTML eyes. */
  breaker: CircuitBreaker;
  notifyAdmin?: (msg: string) => Promise<void>;
}

export class McpToolError extends Error {}

interface Stream {
  tool: string;
  args: Record<string, unknown>;
  cursorKey: string;
}

/** Reads one feed from its cursor down (spec §4.5 paging); nothing is written here. */
async function readStream(mcp: FestMcp, s: Stream, cursor: number | null): Promise<{ items: McpCheckin[]; hole: boolean }> {
  const items: McpCheckin[] = [];
  let maxId: number | undefined;
  for (let pageNo = 1; ; pageNo++) {
    const args = { ...s.args, limit: MCP_PAGE_CAP, ...(cursor !== null ? { minId: cursor } : {}), ...(maxId !== undefined ? { maxId } : {}) };
    const page = parseMcpCheckins(await mcp.call(s.tool, args));
    if ('error' in page) throw new McpToolError(`${s.tool}: ${page.error}`);
    items.push(...page.items);
    const step = pageStep({ cursor, pageNo, count: page.count });
    if (step !== 'more') return { items, hole: step === 'hole' };
    if (page.items.length === 0) return { items, hole: true }; // a full page with nothing readable: cannot page on
    maxId = Math.min(...page.items.map((c) => c.checkinId));
  }
}

function store(db: DB, festId: number, venueIds: Set<number>, items: McpCheckin[], at: string): void {
  const members = festMembersByUsername(db, festId);
  insertVenueCheckins(db, items.filter((c) => c.venueId !== null && venueIds.has(c.venueId)).map((c) => ({
    checkin_id: c.checkinId, venue_id: c.venueId!, bid: c.bid, untappd_user: c.userName, checkin_at: c.checkinAt,
  })), 'friend_feed', at);
  for (const c of items) {
    const telegramIds = members.get(c.userName.toLowerCase());
    if (telegramIds === undefined) continue;
    const beerId = upsertBeerByBid(db, {
      untappd_id: c.bid, name: c.beerName, brewery: c.breweryName, style: c.style, abv: c.abv, rating_global: null,
      normalized_name: normalizeName(c.beerName), normalized_brewery: normalizeBrewery(c.breweryName),
      untappd_id_source: 'checkin',
    });
    for (const telegramId of telegramIds) {
      mergeCheckin(db, {
        checkin_id: String(c.checkinId), telegram_id: telegramId, account_key: getHistoryOwner(db, telegramId).accountKey,
        beer_id: beerId, user_rating: c.rating, checkin_at: c.checkinAt, venue: null,
      });
    }
  }
}

export async function runFestFriendFeed(deps: FestFriendFeedDeps, now: Date): Promise<number | null> {
  const active = activeFests(deps.db, now)[0];
  if (!active) return null;
  const last = getJobState(deps.db, FRIEND_FEED_LAST_KEY);
  if (last !== null && now.getTime() - Date.parse(last) < FRIEND_FEED_EVERY_MS) return null;
  if (!deps.breaker.canAttempt(now)) return null;
  setJobState(deps.db, FRIEND_FEED_LAST_KEY, now.toISOString());

  const owner = deps.mcp.owner();
  const streams: Stream[] = [
    { tool: 'get_my_friend_feed', args: {}, cursorKey: FRIEND_CURSOR_KEY },
    ...(owner ? [{ tool: 'get_user_checkins', args: { username: owner }, cursorKey: OWNER_CURSOR_KEY }] : []),
  ];
  const venueIds = new Set(festVenues(deps.db, active.fest.id).map((v) => v.venue_id));
  let stored = 0;
  try {
    for (const s of streams) {
      const cursorText = getJobState(deps.db, s.cursorKey);
      const cursor = cursorText === null ? null : Number(cursorText);
      const { items, hole } = await readStream(deps.mcp, s, cursor);
      // Rows and the cursor that vouches for them land together, or not at all.
      deps.db.transaction(() => {
        store(deps.db, active.fest.id, venueIds, items, now.toISOString());
        const next = nextCursor(cursor, items.map((c) => c.checkinId));
        if (next !== null) setJobState(deps.db, s.cursorKey, String(next));
      })();
      stored += items.length;
      if (hole) {
        deps.log.warn({ tool: s.tool }, 'fest mcp: more new check-ins than 4 pages; some were skipped');
        await alert(deps, HOLE_ALERT_KEY, now, `Фест: у стрічці ${s.tool} за 5 хв понад ${4 * MCP_PAGE_CAP} чекінів — частину пропущено`);
      }
    }
    deps.breaker.onResult(false, now);
    return stored;
  } catch (e) {
    deps.breaker.onResult(true, now);
    if (isMcpAuthError(e)) {
      await alert(deps, LOGIN_ALERT_KEY, now, 'Фест: MCP-токен Untappd не приймається — запусти scripts/fest-mcp-login.ts і перенеси файл на сервер');
    } else {
      deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'fest mcp: feed read failed');
    }
    return null;
  }
}

async function alert(deps: FestFriendFeedDeps, key: string, now: Date, msg: string): Promise<void> {
  const notify = deps.notifyAdmin;
  if (!notify) return;
  await sendThrottledAlert(deps.db, { key, everyMs: ALERT_EVERY_MS, now, send: () => notify(msg) });
}

export const KEEPALIVE_EVERY_MS = 24 * 60 * 60 * 1000;
export const KEEPALIVE_LAST_KEY = 'fest_mcp_keepalive_at';
const KEEPALIVE_ATTEMPT_KEY = 'fest_mcp_keepalive_attempt_at';
const KEEPALIVE_RETRY_MS = 60 * 60 * 1000;

/**
 * Once a day, festival or not: one cheap call keeps the refresh token used and tells the admin
 * the day it stops working, not on the day of the festival (spec §4.5). A failure is retried
 * hourly; the alert goes out at most once per 6 h.
 */
export async function runFestMcpKeepalive(deps: FestFriendFeedDeps, now: Date): Promise<'ok' | 'failed' | null> {
  const last = getJobState(deps.db, KEEPALIVE_LAST_KEY);
  if (last !== null && now.getTime() - Date.parse(last) < KEEPALIVE_EVERY_MS) return null;
  const attempt = getJobState(deps.db, KEEPALIVE_ATTEMPT_KEY);
  if (attempt !== null && now.getTime() - Date.parse(attempt) < KEEPALIVE_RETRY_MS) return null;
  setJobState(deps.db, KEEPALIVE_ATTEMPT_KEY, now.toISOString());
  try {
    const r = await deps.mcp.call('get_untappd_api_usage', {});
    if (r.isError) throw new McpToolError('get_untappd_api_usage failed');
    setJobState(deps.db, KEEPALIVE_LAST_KEY, now.toISOString());
    return 'ok';
  } catch (e) {
    await alert(deps, LOGIN_ALERT_KEY, now, isMcpAuthError(e)
      ? 'Фест: MCP-токен Untappd не приймається — запусти scripts/fest-mcp-login.ts і перенеси файл на сервер'
      : `Фест: щоденна перевірка MCP не вдалася (${e instanceof Error ? e.message : String(e)})`);
    return 'failed';
  }
}
