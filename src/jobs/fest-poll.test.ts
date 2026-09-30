import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { getFestBySlug } from '../storage/fests';
import { getJobState, setJobState } from '../storage/job_state';
import { menuStats } from '../storage/fest_menu';
import { CookieExpiredError, HttpError, type Http } from '../sources/http';
import { createPersistentCircuitBreaker } from '../domain/untappd-circuit';
import { runFestMenu, runFestPoll, refreshFestMenu, FEST_MENU_LAST_KEY, FEST_POLL_LAST_KEY } from './fest-poll';

const FIX = join(__dirname, '../sources/untappd/__fixtures__');
const MENU = readFileSync(join(FIX, 'venue-menu.html'), 'utf8');
// The raw more_feed fragment doubles as a head page: its rows link to the festival venue.
const FEED = readFileSync(join(FIX, 'venue-more-feed-raw.html'), 'utf8');
const IN_SESSION = new Date('2026-10-15T15:00:00.000Z');

function setup(responses: (string | Error)[]) {
  const db: DB = openDb(':memory:');
  migrate(db);
  const urls: string[] = [];
  const http: Http = {
    async get(url: string) {
      urls.push(url);
      const r = responses.shift();
      if (r === undefined) throw new Error('unexpected request');
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const trips: string[] = [];
  const breaker = createPersistentCircuitBreaker({
    db, key: 'fest_poll_open_until', cooldownMs: 30 * 60 * 1000, blockThreshold: 2,
    onTrip: () => trips.push('trip'), onRecover: () => trips.push('recover'),
  });
  const alerts: string[] = [];
  const deps = { db, log: pino({ level: 'silent' }), http, breaker, notifyAdmin: async (m: string) => { alerts.push(m); } };
  return { db, deps, urls, trips, alerts };
}

describe('runFestPoll', () => {
  it('reads page 1 of the festival /activity feed and ingests it as the server eye', async () => {
    const { db, deps, urls } = setup([FEED]);
    const r = await runFestPoll(deps, IN_SESSION);
    expect(urls).toEqual(['https://untappd.com/v/warsaw-beer-festival-warszawski-festiwal-piwa/11142155/activity']);
    expect(r?.inserted).toBe(3);
    expect(db.prepare('SELECT DISTINCT first_eye FROM venue_checkins').all()).toEqual([{ first_eye: 'server' }]);
    expect(getJobState(db, FEST_POLL_LAST_KEY)).toBe(IN_SESSION.toISOString());
  });

  it('does nothing outside a polling window and before its 10-minute tick', async () => {
    const { deps, urls } = setup([FEED]);
    await runFestPoll(deps, new Date('2026-10-16T02:00:00.000Z'));
    await runFestPoll(deps, IN_SESSION);
    await runFestPoll(deps, new Date(IN_SESSION.getTime() + 9 * 60 * 1000));
    expect(urls).toHaveLength(1);
  });

  it('two blocks in a row open the festival breaker for exactly 30 minutes', async () => {
    const { db, deps, trips } = setup([new HttpError(403, 'u'), new HttpError(403, 'u')]);
    await runFestPoll(deps, IN_SESSION);
    await runFestPoll(deps, new Date(IN_SESSION.getTime() + 10 * 60 * 1000));
    expect(trips).toEqual(['trip']);
    expect(getJobState(db, 'fest_poll_open_until')).toBe(new Date(IN_SESSION.getTime() + 40 * 60 * 1000).toISOString());
  });

  it('a success between blocks keeps the breaker closed', async () => {
    const { db, deps, trips } = setup([new HttpError(403, 'u'), FEED, new HttpError(403, 'u')]);
    for (const m of [0, 10, 20]) await runFestPoll(deps, new Date(IN_SESSION.getTime() + m * 60 * 1000));
    expect([trips, getJobState(db, 'fest_poll_open_until')]).toEqual([[], null]);
  });

  it('an expired cookie alerts the admin once per 6 hours and does not count as a block', async () => {
    const { db, deps, alerts } = setup([new CookieExpiredError(), new CookieExpiredError(), new CookieExpiredError()]);
    expect(await runFestPoll(deps, IN_SESSION)).toBeNull();
    await runFestPoll(deps, new Date(IN_SESSION.getTime() + 10 * 60 * 1000));
    await runFestPoll(deps, new Date(IN_SESSION.getTime() + 6 * 60 * 60 * 1000));
    expect([alerts.length, getJobState(db, 'fest_poll_open_until')]).toEqual([2, null]);
  });
});

describe('cookie alert throttle', () => {
  it('a failed alert does not start the 6-hour silence: the next poll alerts again', async () => {
    const { db, deps } = setup([new CookieExpiredError(), new CookieExpiredError()]);
    const sent: string[] = [];
    const outcomes = [() => Promise.reject(new Error('tg down')), () => Promise.resolve()];
    const withFlaky = { ...deps, notifyAdmin: async (m: string) => { await outcomes.shift()!(); sent.push(m); } };
    await runFestPoll(withFlaky, IN_SESSION);
    await runFestPoll(withFlaky, new Date(IN_SESSION.getTime() + 10 * 60 * 1000));
    expect([sent.length, getJobState(db, 'fest_cookie_alert_at')]).toEqual([1, new Date(IN_SESSION.getTime() + 10 * 60 * 1000).toISOString()]);
  });

  it('two expired-cookie reads in flight at once send one alert', async () => {
    const { deps } = setup([new CookieExpiredError(), new CookieExpiredError()]);
    const sent: string[] = [];
    const slow = { ...deps, notifyAdmin: async (m: string) => { await new Promise((r) => setTimeout(r, 5)); sent.push(m); } };
    const fest = getFestBySlug(deps.db, 'wfp22')!;
    await Promise.all([refreshFestMenu(slow, fest, IN_SESSION), refreshFestMenu(slow, fest, IN_SESSION)]);
    expect(sent.length).toBe(1);
  });
  it('a failed alert never rolls back a newer claim that another read made meanwhile', async () => {
    const { db, deps } = setup([new CookieExpiredError()]);
    const later = new Date(IN_SESSION.getTime() + 7 * 60 * 60 * 1000).toISOString();
    const flaky = { ...deps, notifyAdmin: async () => { setJobState(db, 'fest_cookie_alert_at', later); throw new Error('tg down'); } };
    await refreshFestMenu(flaky, getFestBySlug(db, 'wfp22')!, IN_SESSION);
    expect(getJobState(db, 'fest_cookie_alert_at')).toBe(later);
  });
});

describe('fest menu job', () => {
  it('reads the venue main page (not /activity) and applies the menu', async () => {
    const { db, deps, urls } = setup([MENU]);
    const fest = getFestBySlug(db, 'wfp22')!;
    expect(await refreshFestMenu(deps, fest, new Date('2026-10-09T12:00:00.000Z'))).toEqual({ items: 4, updatedAt: '2026-09-29T12:15:39.465Z', stale: false });
    expect(urls).toEqual(['https://untappd.com/v/warsaw-beer-festival-warszawski-festiwal-piwa/11142155']);
    expect(menuStats(db, fest.id).count).toBe(4);
  });

  it('refuses a page that is not the fest menu venue', async () => {
    const { db, deps } = setup([MENU.replace('/11142155"', '/999"')]);
    expect(await refreshFestMenu(deps, getFestBySlug(db, 'wfp22')!, new Date('2026-10-09T12:00:00.000Z'))).toBe('wrong_page');
    expect(menuStats(db, getFestBySlug(db, 'wfp22')!.id).count).toBe(0);
  });

  it('a failed read does not count: the job retries after 10 minutes, not after 6 hours', async () => {
    const { db, deps, urls } = setup([new HttpError(403, 'u'), MENU]);
    await runFestMenu(deps, new Date('2026-10-09T12:00:00.000Z'));
    expect(getJobState(db, FEST_MENU_LAST_KEY)).toBeNull();
    await runFestMenu(deps, new Date('2026-10-09T12:09:00.000Z'));
    await runFestMenu(deps, new Date('2026-10-09T12:10:00.000Z'));
    expect([urls.length, getJobState(db, FEST_MENU_LAST_KEY)]).toEqual([2, '2026-10-09T12:10:00.000Z']);
  });

  it('a wrong page does not count as a read either', async () => {
    const { db, deps } = setup([MENU.replace('/11142155"', '/999"')]);
    await runFestMenu(deps, new Date('2026-10-09T12:00:00.000Z'));
    expect(getJobState(db, FEST_MENU_LAST_KEY)).toBeNull();
  });

  it('runs on its schedule only: once in the run-up, not again an hour later', async () => {
    const { deps, urls } = setup([MENU, MENU]);
    await runFestMenu(deps, new Date('2026-10-09T12:00:00.000Z'));
    await runFestMenu(deps, new Date('2026-10-09T13:00:00.000Z'));
    expect(urls).toHaveLength(1);
  });
});
