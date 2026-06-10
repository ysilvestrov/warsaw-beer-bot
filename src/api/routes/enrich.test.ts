import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertBeer, findBeerByNormalized } from '../../storage/beers';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { enrichRoute } from './enrich';
import type { ApiEnv } from '../types';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const log = pino({ level: 'silent' });
  const app = new Hono<ApiEnv>();
  enrichRoute(app, { db, env: {} as never, log });
  return { db, app };
}

function post(app: Hono<ApiEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /enrich/candidates', () => {
  it('registers a new beer as an orphan and marks it eligible', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Atak Chmielu' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0]).toMatchObject({ brewery: 'PINTA', name: 'Atak Chmielu', eligible: true });
    expect(body.candidates[0].searchUrl).toContain('untappd.com/search');

    const row = findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Atak Chmielu'));
    expect(row).not.toBeNull();
    expect(row!.untappd_id).toBeNull();
  });

  it('is not eligible when the beer already has an untappd_id', async () => {
    const { db, app } = setup();
    upsertBeer(db, {
      untappd_id: 42, name: 'Atak Chmielu', brewery: 'PINTA', style: null, abv: null, rating_global: 3.9,
      normalized_name: normalizeName('Atak Chmielu'), normalized_brewery: normalizeBrewery('PINTA'),
    });
    const res = await post(app, '/enrich/candidates', { beers: [{ brewery: 'PINTA', name: 'Atak Chmielu' }] });
    const body = await res.json();
    expect(body.candidates[0].eligible).toBe(false);
  });

  it('is not eligible when recently searched (backoff active)', async () => {
    const { db, app } = setup();
    const id = upsertBeer(db, {
      untappd_id: null, name: 'Foo', brewery: 'Bar', style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Foo'), normalized_brewery: normalizeBrewery('Bar'),
    });
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    db.prepare('UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = 1 WHERE id = ?').run(oneHourAgo, id);
    const res = await post(app, '/enrich/candidates', { beers: [{ brewery: 'Bar', name: 'Foo' }] });
    const body = await res.json();
    expect(body.candidates[0].eligible).toBe(false);
  });

  it('400 on an empty beer list', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', { beers: [] });
    expect(res.status).toBe(400);
  });
});
