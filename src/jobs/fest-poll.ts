import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { CookieExpiredError, HttpError } from '../sources/http';
import { isBlockStatus } from '../sources/untappd/block';
import { activeFest, currentOrNextFests, festSessions, festVenues, updateFestVenueFeedPath, POLL_MARGIN_MS, type Fest } from '../storage/fests';
import { getJobState, setJobState } from '../storage/job_state';
import { sendThrottledAlert } from './alert-slot';
import { parseVenueMenu } from '../sources/untappd/venue-menu';
import { dueMenuRefresh, dueServerPoll, type Window } from '../domain/fest/schedule';
import type { CircuitBreaker } from '../domain/untappd-circuit';
import { BlockedPageError, applyMenu, ingestFeedPage, type FeedPageResult, type MenuPageResult } from './fest-ingest';

const UNTAPPD = 'https://untappd.com';
export const FEST_POLL_LAST_KEY = 'fest_poll_last_at';
export const FEST_MENU_LAST_KEY = 'fest_menu_last_at';
export const FEST_MENU_ATTEMPT_KEY = 'fest_menu_attempt_at';
const COOKIE_ALERT_KEY = 'fest_cookie_alert_at';
// A failed menu read is retried, but not on every minute's tick.
export const MENU_RETRY_MS = 10 * 60 * 1000;
const COOKIE_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

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
async function guardedGet(
  deps: FestServerDeps,
  url: string,
  now: Date,
  opts?: { onRedirect?: (fromUrl: string, toUrl: string) => void },
): Promise<string | null> {
  if (!deps.breaker.canAttempt(now)) return null;
  try {
    const html = await deps.http.get(url, opts);
    return html;
  } catch (e) {
    if (e instanceof CookieExpiredError) {
      deps.log.warn('fest: untappd cookie expired');
      // Once per 6 h, not on every 10-minute poll.
      if (deps.notifyAdmin) {
        const notify = deps.notifyAdmin;
        await sendThrottledAlert(deps.db, {
          key: COOKIE_ALERT_KEY, everyMs: COOKIE_ALERT_EVERY_MS, now,
          send: () => notify('Фест: Untappd-кука протухла — серверне око сліпе, онови куку'),
        });
      }
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
  const html = await guardedGet(deps, UNTAPPD + venue.feed_path, now, {
    onRedirect: (_fromUrl, toUrl) => {
      try {
        const u = new URL(toUrl);
        if (u.pathname.includes(`/${venue.venue_id}/`) || u.pathname.endsWith(`/${venue.venue_id}`)) {
          let newFeedPath = u.pathname;
          if (venue.feed_path.endsWith('/activity') && !newFeedPath.endsWith('/activity')) {
            newFeedPath = `${newFeedPath.replace(/\/+$/, '')}/activity`;
          }
          if (newFeedPath !== venue.feed_path) {
            updateFestVenueFeedPath(deps.db, venue.venue_id, newFeedPath);
            deps.log.info({ venueId: venue.venue_id, from: venue.feed_path, to: newFeedPath }, 'fest: venue slug updated');
          }
        }
      } catch {}
    },
  });
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
  // The schedule counts only a read that landed: a blocked, expired or wrong page leaves
  // FEST_MENU_LAST_KEY where it was, so the job retries (after MENU_RETRY_MS) instead of waiting hours.
  setJobState(deps.db, FEST_MENU_ATTEMPT_KEY, now.toISOString());
  const html = await guardedGet(deps, UNTAPPD + path, now, {
    onRedirect: (_fromUrl, toUrl) => {
      try {
        const u = new URL(toUrl);
        if (u.pathname.includes(`/${fest.menu_venue_id}/`) || u.pathname.endsWith(`/${fest.menu_venue_id}`)) {
          const basePath = u.pathname.replace(/\/activity$/, '').replace(/\/+$/, '');
          const newFeedPath = `${basePath}/activity`;
          if (newFeedPath !== menuVenue?.feed_path) {
            updateFestVenueFeedPath(deps.db, fest.menu_venue_id, newFeedPath);
            deps.log.info({ venueId: fest.menu_venue_id, from: menuVenue?.feed_path, to: newFeedPath }, 'fest: menu venue slug updated');
          }
        }
      } catch {}
    },
  });
  if (html === null) return 'blocked';
  const menu = parseVenueMenu(html);
  if (menu.venueId !== fest.menu_venue_id) return 'wrong_page';
  deps.breaker.onResult(false, now);
  const result = applyMenu(deps.db, fest.id, menu, now.toISOString());
  setJobState(deps.db, FEST_MENU_LAST_KEY, now.toISOString());
  return result;
}

/** The menu job: the next fest's menu on the run-up / in-window schedule. */
export async function runFestMenu(deps: FestServerDeps, now: Date): Promise<MenuPageResult | 'blocked' | 'wrong_page' | null> {
  const fest = currentOrNextFests(deps.db, now)[0];
  if (!fest) return null;
  if (!dueMenuRefresh(now, pollingWindows(deps, fest), getJobState(deps.db, FEST_MENU_LAST_KEY))) return null;
  const attempt = getJobState(deps.db, FEST_MENU_ATTEMPT_KEY);
  if (attempt !== null && now.getTime() - Date.parse(attempt) < MENU_RETRY_MS) return null;
  return refreshFestMenu(deps, fest, now);
}
