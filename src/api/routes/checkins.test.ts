import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import { countCheckins } from '../../storage/checkins';
import { getSyncState } from '../../storage/checkin_sync_state';
import { authMiddleware } from '../middleware/auth';
import { checkinsRoute } from './checkins';
import type { ApiEnv } from '../types';

// Synthetic feed pages verified against parseCheckinFeedPage's real selectors.

const PAGE_ONE = `
<html><body>
  <div class="stats"><a><span class="stat">3</span><span class="title">Total</span></a></div>
  <div class="item" data-checkin-id="555">
    <a href="/b/some-ipa/42" class="label"><img></a>
    <p class="text">
      <a href="/user/bob" class="user">Bob</a> is drinking an <a href="/b/some-ipa/42">Some IPA</a>
      by <a href="/SomeBrewery">Some Brewery</a> at <a href="/v/some-bar/7">Some Bar</a>
    </p>
    <div class="caps " data-rating="4.25"></div>
    <a href="/user/bob/checkin/555" class="time timezoner">Mon, 15 Jun 2026 18:00:00 +0000</a>
  </div>
  <a href="#" class="more_checkins">Show More</a>
</body></html>`;

// Same single check-in, NO Show More → feed bottom.
const PAGE_BOTTOM = `
<html><body>
  <div class="item" data-checkin-id="555">
    <a href="/b/some-ipa/42" class="label"><img></a>
    <p class="text">
      <a href="/user/bob" class="user">Bob</a> is drinking an <a href="/b/some-ipa/42">Some IPA</a>
      by <a href="/SomeBrewery">Some Brewery</a>
    </p>
    <a href="/user/bob/checkin/555" class="time timezoner">Mon, 15 Jun 2026 18:00:00 +0000</a>
  </div>
</body></html>`;

const RAW_TOKEN = 'test-checkins-token-abc';
const RAW_TOKEN_NO_USER = 'test-checkins-token-no-user';
const TELEGRAM_ID = 1;
const TELEGRAM_ID_NO_USERNAME = 2;

function setup() {
  const db = openDb(':memory:');
  migrate(db);

  // User with linked Untappd username
  ensureProfile(db, TELEGRAM_ID);
  setUntappdUsername(db, TELEGRAM_ID, 'bob');
  rotateToken(db, TELEGRAM_ID, hashToken(RAW_TOKEN), new Date().toISOString());

  // User with no linked username
  ensureProfile(db, TELEGRAM_ID_NO_USERNAME);
  rotateToken(db, TELEGRAM_ID_NO_USERNAME, hashToken(RAW_TOKEN_NO_USER), new Date().toISOString());

  const log = pino({ level: 'silent' });
  const app = new Hono<ApiEnv>();
  app.use('/checkins/*', authMiddleware(db));
  checkinsRoute(app, { db, env: {} as never, log });

  return { db, app };
}

function get(app: Hono<ApiEnv>, path: string, token?: string) {
  return app.request(path, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function post(app: Hono<ApiEnv>, path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('GET /checkins/sync/state', () => {
  it('returns initial state for a linked user', async () => {
    const { app } = setup();
    const res = await get(app, '/checkins/sync/state', RAW_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      username: 'bob',
      deepest_max_id: null,
      complete: false,
      serverCount: 0,
      profileTotal: null,
    });
  });

  it('returns 409 not_linked when the profile has no username', async () => {
    const { app } = setup();
    const res = await get(app, '/checkins/sync/state', RAW_TOKEN_NO_USER);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'not_linked' });
  });
});

describe('POST /checkins/sync', () => {
  it('merges a page of check-ins and returns correct counts', async () => {
    const { db, app } = setup();
    const res = await post(app, '/checkins/sync', { html: PAGE_ONE, maxId: null }, RAW_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      merged: 1,
      alreadyKnown: 0,
      pageSize: 1,
      nextMaxId: '555',
      profileTotal: 3,
      serverCount: 1,
      complete: false,
    });

    // Check-in persisted
    expect(countCheckins(db, TELEGRAM_ID)).toBe(1);

    // Beer row created with correct untappd_id
    const beer = db.prepare('SELECT * FROM beers WHERE untappd_id = 42').get() as { untappd_id: number } | undefined;
    expect(beer).toBeDefined();
    expect(beer!.untappd_id).toBe(42);

    // Sync cursor advanced
    expect(getSyncState(db, TELEGRAM_ID).deepest_max_id).toBe('555');
  });

  it('is idempotent — posting the same page twice counts as alreadyKnown', async () => {
    const { db, app } = setup();
    await post(app, '/checkins/sync', { html: PAGE_ONE, maxId: null }, RAW_TOKEN);
    const res2 = await post(app, '/checkins/sync', { html: PAGE_ONE, maxId: null }, RAW_TOKEN);
    expect(res2.status).toBe(200);
    const body = await res2.json();
    expect(body).toMatchObject({ merged: 0, alreadyKnown: 1 });
    expect(countCheckins(db, TELEGRAM_ID)).toBe(1);
  });

  it('marks sync complete when no Show More is present', async () => {
    const { db, app } = setup();
    const res = await post(app, '/checkins/sync', { html: PAGE_BOTTOM, maxId: null }, RAW_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ nextMaxId: null, complete: true });
    expect(getSyncState(db, TELEGRAM_ID).complete).toBe(true);
  });

  it('returns 502 blocked when Untappd serves a block page', async () => {
    const { app } = setup();
    const res = await post(
      app,
      '/checkins/sync',
      { html: '<html>Just a moment...</html>' },
      RAW_TOKEN,
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'blocked' });
  });

  it('returns 409 not_linked when the profile has no username', async () => {
    const { app } = setup();
    const res = await post(app, '/checkins/sync', { html: PAGE_ONE }, RAW_TOKEN_NO_USER);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'not_linked' });
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const { app } = setup();
    // No token → authMiddleware returns 401
    const res = await post(app, '/checkins/sync', { html: PAGE_ONE });
    expect(res.status).toBe(401);
  });
});
