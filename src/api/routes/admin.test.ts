import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertBeer } from '../../storage/beers';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { recordEnrichFailure } from '../../storage/enrich_failures';
import { adminMiddleware } from '../middleware/admin';
import { adminRoute } from './admin';
import type { ApiEnv } from '../types';
import type { Env } from '../../config/env';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const log = pino({ level: 'silent' });
  const env = { ADMIN_API_TOKEN: 'secret' } as Env;
  const app = new Hono<ApiEnv>();
  app.use('/admin/*', adminMiddleware(env));
  adminRoute(app, { db, env, log });
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Taking Shape', brewery: 'Track', style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Taking Shape'), normalized_brewery: normalizeBrewery('Track'),
  });
  recordEnrichFailure(db, {
    beer_id: id, brewery: 'Track', name: 'Taking Shape',
    search_url: 'u', source_url: '', outcome: 'not_found',
    candidates_count: 0, candidates_summary: '', at: '2026-06-11T00:00:00Z',
  });
  return { db, app, id };
}

function review(app: Hono<ApiEnv>, body: unknown, token = 'secret') {
  return app.request('/admin/enrich-failures/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('POST /admin/enrich-failures/review', () => {
  it('marks an existing failure as reviewed', async () => {
    const { db, app, id } = setup();
    const res = await review(app, { beer_id: id, review_class: 'parser_bug', note: 'split wrong' });
    expect(res.status).toBe(200);
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBe('parser_bug');
    expect(got.review_note).toBe('split wrong');
  });

  it('404 when no failure exists for beer_id', async () => {
    const { app } = setup();
    const res = await review(app, { beer_id: 99999, review_class: 'wontfix' });
    expect(res.status).toBe(404);
  });

  it('400 on an invalid review_class', async () => {
    const { app, id } = setup();
    const res = await review(app, { beer_id: id, review_class: 'nonsense' });
    expect(res.status).toBe(400);
  });

  it('401 with a bad admin token', async () => {
    const { app, id } = setup();
    const res = await review(app, { beer_id: id, review_class: 'wontfix' }, 'wrong');
    expect(res.status).toBe(401);
  });
});
