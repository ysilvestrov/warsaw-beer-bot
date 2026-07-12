import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertBeer, findBeerByNormalized, getBeer } from '../../storage/beers';
import { recordEnrichFailure, setEnrichFailureReview } from '../../storage/enrich_failures';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { enrichRoute } from './enrich';
import type { ApiEnv } from '../types';
import {
  BEER_TEXT_LIMIT_CHARS,
  ENRICH_CANDIDATES_BODY_LIMIT_BYTES,
  ENRICH_HTML_LIMIT_CHARS,
  ENRICH_RESULT_BODY_LIMIT_BYTES,
  PAGE_URL_LIMIT_CHARS,
} from '../middleware/payload-limit';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const warn = vi.fn();
  const log = { ...pino({ level: 'silent' }), warn } as never;
  const app = new Hono<ApiEnv>();
  enrichRoute(app, { db, env: {} as never, log });
  return { db, app, warn };
}

function post(app: Hono<ApiEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /enrich/candidates', () => {
  it('rejects a raw body over the route byte limit', async () => {
    const { app, warn } = setup();
    const body = `{"padding":"${'x'.repeat(ENRICH_CANDIDATES_BODY_LIMIT_BYTES)}"}`;
    const res = await app.request('/enrich/candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn.mock.calls[0]?.[0]).toEqual({
      method: 'POST', path: '/enrich/candidates', rejectionLayer: 'route',
      limit: ENRICH_CANDIDATES_BODY_LIMIT_BYTES, limitUnit: 'bytes',
      contentLength: body.length, auth: 'anonymous',
    });
  });

  it('rejects a brewery over the per-field character limit', async () => {
    const { app, warn } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'b'.repeat(BEER_TEXT_LIMIT_CHARS + 1), name: 'Beer' }],
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      rejectionLayer: 'schema', limit: BEER_TEXT_LIMIT_CHARS,
      limitUnit: 'characters', fieldPath: 'beers.0.brewery', auth: 'anonymous',
    });
  });

  it('registers a new beer as an orphan and marks it eligible', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Atak Chmielu' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0]).toMatchObject({ brewery: 'PINTA', name: 'Atak Chmielu', eligible: true });
    expect(body.candidates[0].algolia).toMatchObject({
      appId: '9WBO4RQ3HO',
      searchKey: '1d347324d67ec472bb7132c66aead485',
      indexName: 'beer',
      query: 'PINTA Atak Chmielu',
      hitsPerPage: 5,
    });

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

  it('is not eligible when triaged as wontfix', async () => {
    const { db, app } = setup();
    const id = upsertBeer(db, {
      untappd_id: null, name: 'Never', brewery: 'Hopeless', style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Never'), normalized_brewery: normalizeBrewery('Hopeless'),
    });
    recordEnrichFailure(db, {
      beer_id: id, brewery: 'Hopeless', name: 'Never',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: new Date().toISOString(),
    });
    setEnrichFailureReview(db, id, 'wontfix', null, new Date().toISOString());
    const res = await post(app, '/enrich/candidates', { beers: [{ brewery: 'Hopeless', name: 'Never' }] });
    const body = await res.json();
    expect(body.candidates[0].eligible).toBe(false);
  });

  it('candidate Algolia query strips collab junk and both collab breweries (#117)', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'Omnipollo collab/ Trillium Brewing Company', name: 'Kanelbullar' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const query = body.candidates[0].algolia.query as string;
    expect(query).toBe('Omnipollo Trillium Kanelbullar');
    expect(query.toLowerCase()).not.toContain('collab');
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
  it('rejects a raw body over the route byte limit', async () => {
    const { app, warn } = setup();
    const body = `{"padding":"${'x'.repeat(ENRICH_RESULT_BODY_LIMIT_BYTES)}"}`;
    const res = await app.request('/enrich/result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      path: '/enrich/result', rejectionLayer: 'route',
      limit: ENRICH_RESULT_BODY_LIMIT_BYTES, limitUnit: 'bytes', auth: 'anonymous',
    });
  });

  it.each([
    ['html', ENRICH_HTML_LIMIT_CHARS, { brewery: 'B', name: 'N', html: 'x'.repeat(ENRICH_HTML_LIMIT_CHARS + 1) }],
    ['pageUrl', PAGE_URL_LIMIT_CHARS, { brewery: 'B', name: 'N', algolia: {}, pageUrl: 'x'.repeat(PAGE_URL_LIMIT_CHARS + 1) }],
  ])('rejects oversized %s at schema validation', async (fieldPath, limit, body) => {
    const { app, warn } = setup();
    const res = await post(app, '/enrich/result', body);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      path: '/enrich/result', rejectionLayer: 'schema', limit,
      limitUnit: 'characters', fieldPath, auth: 'anonymous',
    });
  });

  it('enriches the orphan from relayed Algolia JSON', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/result', {
      brewery: 'PINTA Barrel Brewing',
      name: 'After Hours: Rose Wild Ale',
      algolia: {
        hits: [{
          bid: 5469263,
          beer_name: 'After Hours: Rose Wild Ale',
          brewery_name: 'PINTA Barrel Brewing',
          type_name: 'Wild Ale - Other',
          beer_abv: 5.7,
          rating_score: 3.89,
        }],
        nbHits: 1,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'matched', untappd_id: 5469263, rating_global: 3.89 });

    const row = findBeerByNormalized(
      db, normalizeBrewery('PINTA Barrel Brewing'), normalizeName('After Hours: Rose Wild Ale'),
    )!;
    expect(getBeer(db, row.id)!.untappd_id).toBe(5469263);
  });

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

  it('reports an already-matched beer without overwriting it', async () => {
    const { db, app } = setup();
    upsertBeer(db, {
      untappd_id: 111, name: 'Atak Chmielu', brewery: 'PINTA', style: null, abv: null, rating_global: 4.0,
      normalized_name: normalizeName('Atak Chmielu'), normalized_brewery: normalizeBrewery('PINTA'),
    });
    // Algolia JSON that would otherwise match a DIFFERENT bid:
    const res = await post(app, '/enrich/result', {
      brewery: 'PINTA',
      name: 'Atak Chmielu',
      algolia: {
        hits: [{
          bid: 999,
          beer_name: 'Atak Chmielu',
          brewery_name: 'PINTA',
          rating_score: 2.0,
        }],
      },
    });
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 111, rating_global: 4.0 });

    const row = findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Atak Chmielu'))!;
    expect(getBeer(db, row.id)!.untappd_id).toBe(111);          // unchanged
    expect(getBeer(db, row.id)!.rating_global).toBeCloseTo(4.0); // unchanged
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

  it('stores the supplied pageUrl as the failure source_url', async () => {
    const { db, app } = setup();
    const html = searchHtml([{ bid: 9000, name: 'Totally Different', brewery: 'Other Brewery' }]);
    await post(app, '/enrich/result', {
      brewery: 'Magic Road Brewery',
      name: 'Fifty/Fifty Clementine & Passionfruit',
      html,
      pageUrl: 'https://beerfreak.org/p/abc',
    });
    const row = findBeerByNormalized(
      db, normalizeBrewery('Magic Road Brewery'), normalizeName('Fifty/Fifty Clementine & Passionfruit'),
    )!;
    const fail = db.prepare('SELECT source_url FROM enrich_failures WHERE beer_id = ?').get(row.id) as any;
    expect(fail.source_url).toBe('https://beerfreak.org/p/abc');
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
