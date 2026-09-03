import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import { countCheckins } from '../../storage/checkins';
import { getSyncState } from '../../storage/checkin_sync_state';
import { addCoverage, coverageFor } from '../../storage/checkin_coverage';
import { authMiddleware } from '../middleware/auth';
import { checkinsRoute } from './checkins';
import type { ApiEnv } from '../types';
import {
  CHECKINS_HTML_LIMIT_CHARS,
  CHECKINS_SYNC_BODY_LIMIT_BYTES,
} from '../middleware/payload-limit';

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
// Feed bottom = a page (more_feed fragment) with zero check-in items. The walk stops
// here (nextMaxId null → complete), not on the absence of a Show More button.
const PAGE_BOTTOM = `<html><body></body></html>`;

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

  const warn = vi.fn();
  const log = { ...pino({ level: 'silent' }), warn } as never;
  const app = new Hono<ApiEnv>();
  app.use('/checkins/*', authMiddleware(db));
  checkinsRoute(app, { db, env: {} as never, log });

  return { db, app, warn };
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
  it('rejects an oversized raw body at the route limit without mutating sync data', async () => {
    const { db, app, warn } = setup();
    const body = `{"padding":"${'x'.repeat(CHECKINS_SYNC_BODY_LIMIT_BYTES)}"}`;
    const res = await app.request('/checkins/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        Authorization: `Bearer ${RAW_TOKEN}`,
      },
      body,
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn).toHaveBeenCalledWith(
      {
        method: 'POST', path: '/checkins/sync', rejectionLayer: 'route',
        limit: CHECKINS_SYNC_BODY_LIMIT_BYTES, limitUnit: 'bytes',
        contentLength: body.length, auth: 'authenticated', telegramId: TELEGRAM_ID,
      },
      'api payload too large',
    );
    expect(countCheckins(db, TELEGRAM_ID)).toBe(0);
    expect(getSyncState(db, TELEGRAM_ID)).toMatchObject({ deepest_max_id: null, complete: false });
  });

  it('rejects oversized html at schema validation without mutating sync data', async () => {
    const { db, app, warn } = setup();
    const res = await post(
      app,
      '/checkins/sync',
      { html: 'x'.repeat(CHECKINS_HTML_LIMIT_CHARS + 1) },
      RAW_TOKEN,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST', path: '/checkins/sync', rejectionLayer: 'schema',
      limit: CHECKINS_HTML_LIMIT_CHARS, limitUnit: 'characters',
      auth: 'authenticated', telegramId: TELEGRAM_ID, fieldPath: 'html',
    });
    expect(countCheckins(db, TELEGRAM_ID)).toBe(0);
    expect(getSyncState(db, TELEGRAM_ID)).toMatchObject({ deepest_max_id: null, complete: false });
  });

  it('keeps ordinary malformed payloads as 400 responses', async () => {
    const { app } = setup();
    expect((await post(app, '/checkins/sync', {}, RAW_TOKEN)).status).toBe(400);
  });

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
    const beer = db.prepare('SELECT * FROM beers WHERE untappd_id = 42').get() as { untappd_id: number; untappd_id_source: string } | undefined;
    expect(beer).toBeDefined();
    expect(beer!.untappd_id).toBe(42);
    // #384: check-in sync writes Untappd's own record — provenance is 'checkin'
    expect(beer!.untappd_id_source).toBe('checkin');

    // user_rating round-trips through the parser and storage
    const row = db.prepare('SELECT user_rating FROM checkins WHERE checkin_id = ?').get('555') as { user_rating: number };
    expect(row.user_rating).toBe(4.25);
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

  // #587: дно стрічки недоказове — порожня сторінка без відомих чекінів це просто
  // порожній акаунт, і `complete` більше ніде не виставляється в true.
  it('accepts an empty page with no prior checkins as an empty account', async () => {
    const { app } = setup();
    const res = await post(app, '/checkins/sync', { html: PAGE_BOTTOM, maxId: null }, RAW_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ pageSize: 0, nextMaxId: null, nextCursor: null, complete: false });
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

// Сторінка фіду з довільних id, newest→oldest, за тими самими селекторами, що й PAGE_ONE.
function pageOf(ids: number[]): string {
  const items = ids.map((id) => `
    <div class="item" data-checkin-id="${id}">
      <p class="text">
        <a href="/user/bob" class="user">Bob</a> is drinking an <a href="/b/ipa-${id}/${id}">Beer ${id}</a>
        by <a href="/SomeBrewery">Some Brewery</a>
      </p>
      <a href="/user/bob/checkin/${id}" class="time timezoner">Mon, 15 Jun 2026 18:00:00 +0000</a>
    </div>`).join('');
  return `<html><body>${items}</body></html>`;
}

describe('POST /checkins/sync — покриття і nextCursor (#587)', () => {
  it('records the page range and steps down when nothing is covered yet', async () => {
    const { app, db } = setup();
    const res = await post(app, '/checkins/sync', { html: pageOf([600, 590, 580]), maxId: null }, RAW_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBe('580');
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 580, to_id: 600 }]);
  });

  it('uses the request cursor as the upper bound of the proven range', async () => {
    const { app, db } = setup();
    await post(app, '/checkins/sync', { html: pageOf([600, 580]), maxId: null }, RAW_TOKEN);
    await post(app, '/checkins/sync', { html: pageOf([570, 560]), maxId: '580' }, RAW_TOKEN);
    // Друга сторінка доводить [560, 580], і 580 склеює її з першою.
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 560, to_id: 600 }]);
  });

  it('jumps below covered territory instead of walking through it', async () => {
    const { app, db } = setup();
    addCoverage(db, TELEGRAM_ID, 100, 500);
    const res = await post(app, '/checkins/sync', { html: pageOf([600, 550, 500]), maxId: null }, RAW_TOKEN);
    // Сторінка дотягнулася до 500 — це вже покрите, тож стрибаємо під увесь блок.
    expect((await res.json()).nextCursor).toBe('100');
  });

  // Регресія #587: діра ПІД верхньою сторінкою і НАД старим покриттям.
  it('does not jump over a hole that lies below the page', async () => {
    const { app, db } = setup();
    addCoverage(db, TELEGRAM_ID, 100, 200);
    const res = await post(app, '/checkins/sync', { html: pageOf([600, 590, 580]), maxId: null }, RAW_TOKEN);
    // 580 не дотикається до [100,200]: між ними діра, і йти треба в неї, а не під неї.
    expect((await res.json()).nextCursor).toBe('580');
    const res2 = await post(app, '/checkins/sync', { html: pageOf([300, 200]), maxId: '580' }, RAW_TOKEN);
    // Ця сторінка закрила діру й склеїла все: тепер стрибок аж під низ.
    expect((await res2.json()).nextCursor).toBe('100');
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 100, to_id: 600 }]);
  });

  it('stops the walk when the counts already agree', async () => {
    const { app } = setup();
    // profileTotal = 3 приходить зі сторінки профілю, і рівно 3 чекіни на ній.
    const html = pageOf([600, 590, 580]).replace(
      '<body>',
      '<body><div class="stats"><a><span class="stat">3</span><span class="title">Total</span></a></div>',
    );
    const res = await post(app, '/checkins/sync', { html, maxId: null }, RAW_TOKEN);
    expect((await res.json()).nextCursor).toBeNull();
  });

  it('accepts an empty page at or below the oldest known checkin as the end of the walk', async () => {
    const { app, db } = setup();
    await post(app, '/checkins/sync', { html: pageOf([600, 580]), maxId: null }, RAW_TOKEN);
    const res = await post(app, '/checkins/sync', { html: '<html><body></body></html>', maxId: '580' }, RAW_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.pageSize).toBe(0);
    // Нічого про дно не записано: покриття лишилось тим, що довели сторінки.
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 580, to_id: 600 }]);
  });

  // Порожньо там, де наш власний чекін мав би повернутися → сесія зламана, не дно.
  it('rejects an empty page above the oldest known checkin as a dead session', async () => {
    const { app, db } = setup();
    await post(app, '/checkins/sync', { html: pageOf([600, 580]), maxId: null }, RAW_TOKEN);
    const res = await post(app, '/checkins/sync', { html: '<html><body></body></html>', maxId: '900' }, RAW_TOKEN);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'no_session' });
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 580, to_id: 600 }]);
  });

  it('treats an empty profile page as an empty account, not a dead session', async () => {
    const { app } = setup();
    const res = await post(app, '/checkins/sync', { html: '<html><body></body></html>', maxId: null }, RAW_TOKEN);
    expect(res.status).toBe(200);
    expect((await res.json()).nextCursor).toBeNull();
  });

  it('rejects a non-numeric cursor instead of failing inside the transaction', async () => {
    const { app } = setup();
    const res = await post(app, '/checkins/sync', { html: pageOf([600]), maxId: 'abc' }, RAW_TOKEN);
    expect(res.status).toBe(400);
  });

  // Стара версія розширення ігнорує `nextCursor` і шле сторінки за власною логікою,
  // обриваючись на першій повністю відомій. Сервер від цього не мусить нічого ствердити:
  // кожна сторінка доводить лише СВІЙ діапазон, і діра лишається видимою.
  it('records only what each page proves, even when the pages do not form a chain', async () => {
    const { app, db } = setup();
    await post(app, '/checkins/sync', { html: pageOf([600, 580]), maxId: null }, RAW_TOKEN);
    await post(app, '/checkins/sync', { html: pageOf([300, 200]), maxId: '310' }, RAW_TOKEN);
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([
      { from_id: 580, to_id: 600 },
      { from_id: 200, to_id: 310 },
    ]);
  });

  // Task 3 (доповнення до брифу): нічого в наборі тестів досі не перевіряло, що лічильник
  // профілю, розпарсений зі сторінки, справді ЗБЕРІГАЄТЬСЯ — коментар до виклику
  // recordProfileTotal лишав би цей набір зеленим. Читаємо назад ОКРЕМИМ пізнішим викликом.
  it('persists the profile total parsed from a page so a later call can read it back', async () => {
    const { app, db } = setup();
    const html = pageOf([600, 590, 580]).replace(
      '<body>',
      '<body><div class="stats"><a><span class="stat">42</span><span class="title">Total</span></a></div>',
    );
    const postRes = await post(app, '/checkins/sync', { html, maxId: null }, RAW_TOKEN);
    expect((await postRes.json()).profileTotal).toBe(42);

    // Окремий пізніший виклик, а не той самий response, де total щойно спарсили:
    // це доводить, що значення дійсно ЗАПИСАНЕ в стан, а не лише пройшло крізь відповідь.
    expect(getSyncState(db, TELEGRAM_ID).profile_total).toBe(42);
  });
});
