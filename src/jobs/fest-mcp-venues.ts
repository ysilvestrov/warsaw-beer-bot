import { activeFest, festVenues } from '../storage/fests';
import { getJobState, setJobState } from '../storage/job_state';
import { MCP_PAGE_CAP, nextCursor, venuePageStep } from '../domain/fest/mcp-paging';
import { parseMcpCheckins, type McpCheckin } from '../sources/untappd/mcp-checkins';
import { McpToolError, type FestFriendFeedDeps } from './fest-friend-feed';
import { ingestCheckinRows } from './fest-ingest';

// MCP venue eye (spec 2026-10-02-wfp-mcp-venue-eye-design.md): the server reads each festival
// venue's own feed through the Untappd MCP — no browser, no Cloudflare, no cookie. It pages down
// from the head with maxId, never with minId (a minId older than 10 days is refused, and the first
// read of every session would be), and hands every page to the same write path as the HTML eyes.

export const VENUE_EVERY_MS = { menu: 3 * 60 * 1000, other: 6 * 60 * 1000 };
/** Without a cursor, the first read of a window reaches this far before the session start. */
export const FIRST_READ_BEFORE_START_MS = 60 * 60 * 1000;
/** Per session: the first read of every session starts from the head down to its own floor. */
export const venueCursorKey = (festId: number, sessionNo: number, venueId: number): string =>
  `fest_mcp_venue_cursor:${festId}:${sessionNo}:${venueId}`;
/**
 * Venue reads share the owner's 100 calls per rolling hour with the friend feed (~24/h) and the
 * owner's own connector; this eye never spends more than this many in any hour.
 */
export const VENUE_CALLS_PER_HOUR = 60;
const CALLS_KEY = 'fest_mcp_venue_calls';
const HOUR_MS = 60 * 60 * 1000;
export const venueLastKey = (venueId: number): string => `fest_mcp_venue_last_at:${venueId}`;
/** Any read, ok or not: a failing venue is retried at its own cadence, not on every minute's tick. */
export const venueAttemptKey = (venueId: number): string => `fest_mcp_venue_attempt_at:${venueId}`;

const rowOf = (c: McpCheckin) => ({
  checkin_id: c.checkinId, venue_id: c.venueId, bid: c.bid, untappd_user: c.userName, checkin_at: c.checkinAt,
});

/** Takes one call from the rolling-hour budget; false when the hour is spent. */
function takeCall(db: FestFriendFeedDeps['db'], now: Date): boolean {
  const text = getJobState(db, CALLS_KEY);
  const recent = (text === null ? [] : (JSON.parse(text) as number[])).filter((t) => now.getTime() - t < HOUR_MS);
  if (recent.length >= VENUE_CALLS_PER_HOUR) return false;
  setJobState(db, CALLS_KEY, JSON.stringify([...recent, now.getTime()]));
  return true;
}

/**
 * One venue, head page down to its cursor (or the floor); every page is written as it comes.
 * `complete: false` when the hourly budget ran out mid-read: the cursor then stays where it was, so
 * the next read pages down to it again (rows already written are deduplicated).
 */
async function readVenue(deps: FestFriendFeedDeps, cursorKey: string, venueId: number, floorAt: string, now: Date): Promise<{ inserted: number; complete: boolean }> {
  const cursorText = getJobState(deps.db, cursorKey);
  const cursor = cursorText === null ? null : Number(cursorText);
  const seen: number[] = [];
  let inserted = 0;
  let maxId: number | null = null;
  for (let pageNo = 1; ; pageNo++) {
    if (!takeCall(deps.db, now)) {
      deps.log.warn({ venueId }, 'fest mcp venue: hourly call budget spent; read deferred');
      return { inserted, complete: false };
    }
    const page = parseMcpCheckins(await deps.mcp.call('get_venue_checkins', {
      venueId, limit: MCP_PAGE_CAP, ...(maxId !== null ? { maxId } : {}),
    }));
    if ('error' in page) throw new McpToolError(`get_venue_checkins ${venueId}: ${page.error}`);
    // A page below maxId proves its span up to that check-in, which the page above just stored. A
    // record the parser could not read is a check-in we cannot vouch for: no coverage from that page.
    inserted += ingestCheckinRows(deps.db, {
      venueId, rows: page.items.map(rowOf), cursor: maxId, fetchedAt: now.toISOString(),
      eye: 'mcp_venue', now: now.toISOString(), provesCoverage: !page.cached && page.items.length === page.count,
    }).inserted;
    const ids = page.items.map((c) => c.checkinId);
    seen.push(...ids);
    const oldestAt = page.items.length === 0 ? null : page.items[page.items.length - 1].checkinAt;
    const step = venuePageStep({ cursor, floorAt, pageNo, count: page.count, ids, oldestAt });
    if (step === 'hole') {
      // The cursor still moves to the newest check-in: the gap stays visible in coverage as ❔.
      deps.log.warn({ venueId }, 'fest mcp venue: could not read down to the cursor; some check-ins were skipped');
    }
    if (step !== 'more') break;
    maxId = Math.min(...ids);
  }
  deps.db.transaction(() => {
    const next = nextCursor(cursor, seen);
    if (next !== null) setJobState(deps.db, cursorKey, String(next));
    setJobState(deps.db, venueLastKey(venueId), now.toISOString());
  })();
  return { inserted, complete: true };
}

/**
 * Every venue of the fest being polled whose turn has come: the menu venue every 3 min, the others
 * every 6. A failing venue keeps its cursor, is retried at its own cadence, and does not stop the
 * others; the breaker is the MCP one, shared with the friend feed.
 */
export async function runFestMcpVenues(deps: FestFriendFeedDeps, now: Date): Promise<number | null> {
  const active = activeFest(deps.db, now);
  if (!active) return null;
  if (!deps.breaker.canAttempt(now)) return null;
  const floorAt = new Date(Date.parse(active.session.start_at) - FIRST_READ_BEFORE_START_MS).toISOString();
  let inserted = 0;
  let failed = false;
  let read = false;
  // The menu venue first: it is read most often, and a tick cut short by a failure should still have it.
  const venues = festVenues(deps.db, active.fest.id)
    .sort((a, b) => Number(b.venue_id === active.fest.menu_venue_id) - Number(a.venue_id === active.fest.menu_venue_id));
  for (const v of venues) {
    const every = v.venue_id === active.fest.menu_venue_id ? VENUE_EVERY_MS.menu : VENUE_EVERY_MS.other;
    const attempt = getJobState(deps.db, venueAttemptKey(v.venue_id));
    if (attempt !== null && now.getTime() - Date.parse(attempt) < every) continue;
    setJobState(deps.db, venueAttemptKey(v.venue_id), now.toISOString());
    read = true;
    try {
      const r = await readVenue(deps, venueCursorKey(active.fest.id, active.session.session_no, v.venue_id), v.venue_id, floorAt, now);
      inserted += r.inserted;
      if (!r.complete) break; // the hour's budget is spent: the other venues wait too
    } catch (e) {
      failed = true;
      deps.log.warn({ venueId: v.venue_id, err: e instanceof Error ? e.message : String(e) }, 'fest mcp venue: read failed');
    }
  }
  // A tick that read nothing says nothing: the breaker is shared with the friend feed, and a quiet
  // minute here must not wipe the count of its failures.
  if (read) deps.breaker.onResult(failed, now);
  return inserted;
}
