import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertBeer, findBeerByNormalized, getBeer } from '../../storage/beers';
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

// Minimal Untappd search markup parseSearchPage understands (mirrors untappd-lookup.test).
function searchHtml(
  items: Array<{ bid: number; name: string; brewery: string; rating?: string }>,
): string {
  const cards = items
    .map(
      (it) => `
      <div class="beer-item"><div class="beer-details">
        <p class="name"><a href="/b/x/${it.bid}">${it.name}</a></p>
        <p class="brewery"><a>${it.brewery}</a></p>
        <p class="style">IPA</p>
      </div><div class="details beer">
        <p class="abv">5% ABV</p>
        <div class="rating"><div class="caps" data-rating="${it.rating ?? '3.5'}"></div></div>
      </div></div>`,
    )
    .join('');
  return `<html><body>${cards}</body></html>`;
}

describe('POST /enrich/result', () => {
  it('enriches the orphan on a matched search result', async () => {
    const { db, app } = setup();
    const html = searchHtml([
      { bid: 5001, name: 'Fifty/Fifty Clementine & Passionfruit', brewery: 'Magic Road', rating: '3.98' },
    ]);
    const res = await post(app, '/enrich/result', {
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      html,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'matched', untappd_id: 5001 });

    const row = findBeerByNormalized(
      db, normalizeBrewery('Magic Road Brewery'), normalizeName('Fifty/Fifty Clementine & Passionfruit'),
    )!;
    expect(getBeer(db, row.id)!.untappd_id).toBe(5001);
    expect(getBeer(db, row.id)!.rating_global).toBeCloseTo(3.98);
  });

  it('records not_found and bumps the backoff when nothing matches', async () => {
    const { db, app } = setup();
    const html = searchHtml([{ bid: 9000, name: 'Totally Different', brewery: 'Other Brewery' }]);
    const res = await post(app, '/enrich/result', {
      brewery: 'Magic Road Brewery', name: 'Fifty/Fifty Clementine & Passionfruit', html,
    });
    const body = await res.json();
    expect(body.status).toBe('not_found');

    const row = findBeerByNormalized(
      db, normalizeBrewery('Magic Road Brewery'), normalizeName('Fifty/Fifty Clementine & Passionfruit'),
    )!;
    expect(getBeer(db, row.id)!.untappd_lookup_count).toBe(1);
  });

  it('reports blocked without mutating backoff when Untappd serves a block page', async () => {
    const { db, app } = setup();
    // Cloudflare "Just a moment..." interstitial — isBlockPage flags this.
    const html = '<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>';
    const res = await post(app, '/enrich/result', {
      brewery: 'Magic Road Brewery', name: 'Fifty/Fifty Clementine & Passionfruit', html,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('blocked');

    const row = findBeerByNormalized(
      db, normalizeBrewery('Magic Road Brewery'), normalizeName('Fifty/Fifty Clementine & Passionfruit'),
    )!;
    const after = getBeer(db, row.id)!;
    // A block must NOT mutate backoff state.
    expect(after.untappd_lookup_at).toBeNull();
    expect(after.untappd_lookup_count).toBe(0);
  });
});
