import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { CookieExpiredError, HttpError } from '../sources/http';
import { isBlockStatus } from '../sources/untappd/block';
import { activeFest, currentOrNextFests, festSessions, festVenues, POLL_MARGIN_MS, type Fest } from '../storage/fests';
import { getJobState, setJobState } from '../storage/job_state';
import { parseVenueMenu } from '../sources/untappd/venue-menu';
import { dueMenuRefresh, dueServerPoll, type Window } from '../domain/fest/schedule';
import type { CircuitBreaker } from '../domain/untappd-circuit';
import { BlockedPageError, applyMenu, ingestFeedPage, type FeedPageResult, type MenuPageResult } from './fest-ingest';

const UNTAPPD = 'https://untappd.com';
export const FEST_POLL_LAST_KEY = 'fest_poll_last_at';
export const FEST_MENU_LAST_KEY = 'fest_menu_last_at';

export interface FestServerDeps {
  db: DB;
  log: pino.Logger;
  /** The cookie'd Untappd client (on-block rotation) shared with refreshAllUntappd. */
  http: Http;
  /** Festival breaker: its own job_state key, so it never gates the nightly profile job. */
  breaker: CircuitBreaker;
  notifyAdmin?: (msg: string) => Promise<void>;
}

const isBlock = (e: unknown): boolean =>
  e instanceof BlockedPageError || (e instanceof HttpError && isBlockStatus(e.status));

// One guarded fetch: breaker gate, block → breaker, expired cookie → admin alert (not a block:
// it is a session problem, and rotating or cooling down would not fix it).
async function guardedGet(deps: FestServerDeps, url: string, now: Date): Promise<string | null> {
  if (!deps.breaker.canAttempt(now)) return null;
  try {
    const html = await deps.http.get(url);
    return html;
  } catch (e) {
    if (e instanceof CookieExpiredError) {
      deps.log.warn('fest: untappd cookie expired');
      await deps.notifyAdmin?.('Фест: Untappd-кука протухла — серверне око сліпе, онови куку').catch(() => {});
      return null;
    }
    if (isBlock(e)) {
      deps.breaker.onResult(true, now);
      deps.log.warn({ url }, 'fest: untappd block');
      return null;
    }
    throw e;
  }
}

/** Server eye (spec §4.4): page 1 of the festival venue feed, every 10 min in a polling window. */
export async function runFestPoll(deps: FestServerDeps, now: Date): Promise<FeedPageResult | null> {
  const active = activeFest(deps.db, now);
  if (!dueServerPoll(now, active !== null, getJobState(deps.db, FEST_POLL_LAST_KEY))) return null;
  const venue = festVenues(deps.db, active!.fest.id).find((v) => v.venue_id === active!.fest.menu_venue_id);
  if (!venue) return null;
  setJobState(deps.db, FEST_POLL_LAST_KEY, now.toISOString());
  const html = await guardedGet(deps, UNTAPPD + venue.feed_path, now);
  if (html === null) return null;
  try {
    const result = ingestFeedPage(deps.db, {
      venueId: venue.venue_id, html, cursor: null, fetchedAt: now.toISOString(), eye: 'server', now: now.toISOString(),
    });
    deps.breaker.onResult(false, now);
    return result;
  } catch (e) {
    if (e instanceof BlockedPageError) {
      deps.breaker.onResult(true, now);
      return null;
    }
    throw e;
  }
}

function pollingWindows(deps: FestServerDeps, fest: Fest): Window[] {
  return festSessions(deps.db, fest.id).map((s) => ({
    start_at: new Date(Date.parse(s.start_at) - POLL_MARGIN_MS).toISOString(),
    end_at: new Date(Date.parse(s.end_at) + POLL_MARGIN_MS).toISOString(),
  }));
}

/** Reads the menu page of `fest` now, whatever the schedule; used by the job and by /fest menu. */
export async function refreshFestMenu(deps: FestServerDeps, fest: Fest, now: Date): Promise<MenuPageResult | 'blocked' | 'wrong_page'> {
  const menuVenue = festVenues(deps.db, fest.id).find((v) => v.venue_id === fest.menu_venue_id);
  // The menu lives on the venue's main page; the feed path of the festival venue ends in /activity.
  const path = (menuVenue?.feed_path ?? `/v/x/${fest.menu_venue_id}`).replace(/\/activity$/, '');
  setJobState(deps.db, FEST_MENU_LAST_KEY, now.toISOString());
  const html = await guardedGet(deps, UNTAPPD + path, now);
  if (html === null) return 'blocked';
  const menu = parseVenueMenu(html);
  if (menu.venueId !== fest.menu_venue_id) return 'wrong_page';
  deps.breaker.onResult(false, now);
  return applyMenu(deps.db, fest.id, menu, now.toISOString());
}

/** The menu job: the next fest's menu on the run-up / in-window schedule. */
export async function runFestMenu(deps: FestServerDeps, now: Date): Promise<MenuPageResult | 'blocked' | 'wrong_page' | null> {
  const fest = currentOrNextFests(deps.db, now)[0];
  if (!fest) return null;
  if (!dueMenuRefresh(now, pollingWindows(deps, fest), getJobState(deps.db, FEST_MENU_LAST_KEY))) return null;
  return refreshFestMenu(deps, fest, now);
}
