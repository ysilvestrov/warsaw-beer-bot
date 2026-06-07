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

function setup() {
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
  const log = pino({ level: 'silent' });

  function appAs(telegramId: number) {
    const app = new Hono<ApiEnv>();
    app.use('/match', async (c, next) => { c.set('telegramId', telegramId); await next(); });
    matchRoute(app, { db, env: {} as never, log });
    return app;
  }
  return { appAs, panIpani };
}

function post(app: Hono<ApiEnv>, body: unknown) {
  return app.request('/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /match', () => {
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
});
