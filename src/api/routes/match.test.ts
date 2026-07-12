import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { matchRoute } from './match';
import type { ApiEnv } from '../types';
import { BEER_TEXT_LIMIT_CHARS, MATCH_BODY_LIMIT_BYTES } from '../middleware/payload-limit';

function setup(log?: pino.Logger) {
  const warn = vi.fn();
  const appLog = log ?? ({ ...pino({ level: 'silent' }), warn } as never);
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  ensureProfile(db, 2);
  const panIpani = upsertBeer(db, {
    untappd_id: 9001, name: 'Pan IPAni', brewery: 'Trzech Kumpli',
    style: 'IPA', abv: 6.0, rating_global: 3.85,
    normalized_name: normalizeName('Pan IPAni'),
    normalized_brewery: normalizeBrewery('Trzech Kumpli'),
  });
  mergeCheckin(db, {
    checkin_id: 'c1', telegram_id: 1, beer_id: panIpani,
    user_rating: 4.0, checkin_at: '2026-01-01T00:00:00Z', venue: null,
  });
  function appAs(telegramId: number) {
    const app = new Hono<ApiEnv>();
    app.use('/match', async (c, next) => { c.set('telegramId', telegramId); await next(); });
    matchRoute(app, { db, env: {} as never, log: appLog });
    return app;
  }
  function appAnon() {
    const app = new Hono<ApiEnv>();
    // No middleware sets telegramId → route must treat it as anonymous.
    matchRoute(app, { db, env: {} as never, log: appLog });
    return app;
  }
  return { appAs, appAnon, panIpani, warn };
}

function post(app: Hono<ApiEnv>, body: unknown) {
  return app.request('/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /match', () => {
  it('rejects an anonymous raw body over the route byte limit', async () => {
    const { appAnon, warn } = setup();
    const body = `{"padding":"${'x'.repeat(MATCH_BODY_LIMIT_BYTES)}"}`;
    const res = await appAnon().request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn.mock.calls[0]?.[0]).toEqual({
      method: 'POST', path: '/match', rejectionLayer: 'route',
      limit: MATCH_BODY_LIMIT_BYTES, limitUnit: 'bytes',
      contentLength: body.length, auth: 'anonymous',
    });
  });

  it('rejects an oversized name with authenticated identity metadata', async () => {
    const { appAs, warn } = setup();
    const res = await post(appAs(1), {
      beers: [{ brewery: 'B', name: 'n'.repeat(BEER_TEXT_LIMIT_CHARS + 1) }],
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      path: '/match', rejectionLayer: 'schema', limit: BEER_TEXT_LIMIT_CHARS,
      limitUnit: 'characters', fieldPath: 'beers.0.name',
      auth: 'authenticated', telegramId: 1,
    });
  });

  it('returns drunk status + personal rating for the calling user', async () => {
    const { appAs } = setup();
    const res = await post(appAs(1), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({
      matched_beer: { name: 'Pan IPAni', rating_global: 3.85 },
      is_drunk: true,
      user_rating: 4.0,
    });
  });

  it('includes the matched beer untappd_id in the response', async () => {
    const { appAs } = setup();
    const res = await post(appAs(1), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    const body = await res.json();
    expect(body.results[0].matched_beer.untappd_id).toBe(9001);
  });

  it('isolates users — user 2 has not drunk the beer', async () => {
    const { appAs } = setup();
    const res = await post(appAs(2), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    const body = await res.json();
    expect(body.results[0].is_drunk).toBe(false);
    expect(body.results[0].user_rating).toBeNull();
  });

  it('400 on an invalid body', async () => {
    const { appAs } = setup();
    const res = await post(appAs(1), { beers: [] }); // violates .min(1)
    expect(res.status).toBe(400);
  });

  it('400 when more than 200 beers are sent', async () => {
    const { appAs } = setup();
    const beers = Array.from({ length: 201 }, (_, i) => ({ brewery: `B${i}`, name: `N${i}` }));
    const res = await post(appAs(1), { beers });
    expect(res.status).toBe(400);
  });

  it('returns global-only data anonymously when no telegramId is set', async () => {
    const { appAnon } = setup();
    const res = await post(appAnon(), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({
      matched_beer: { name: 'Pan IPAni', rating_global: 3.85, untappd_id: 9001 },
      is_drunk: false,
      drunk_uncertain: false,
      user_rating: null,
    });
  });

  it('logs full-fallback stats at info', async () => {
    const lines: any[] = [];
    const log = pino({ level: 'info' }, { write: (s: string) => lines.push(JSON.parse(s)) });
    const { appAs } = setup(log);
    await post(appAs(1), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    const stat = lines.find((l) => l.msg === 'match fallback stats');
    expect(stat).toBeTruthy();
    expect(stat.items).toBe(1);
    expect(stat.fullFallback).toEqual({ attempts: 0, hits: 0, budgetSkipped: 0 });
  });
});
