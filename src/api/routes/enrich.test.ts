import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertBeer, findBeerByNormalized, getBeer } from '../../storage/beers';
import { recordEnrichFailure, setEnrichFailureReview } from '../../storage/enrich_failures';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { enrichRoute } from './enrich';
import type { ApiDeps, ApiEnv } from '../types';
import {
  BEER_TEXT_LIMIT_CHARS,
  ENRICH_CANDIDATES_BODY_LIMIT_BYTES,
  ENRICH_HTML_LIMIT_CHARS,
  ENRICH_RESULT_BODY_LIMIT_BYTES,
  PAGE_URL_LIMIT_CHARS,
} from '../middleware/payload-limit';

function setup(depsOverride?: Partial<ApiDeps>) {
  const db = openDb(':memory:');
  migrate(db);
  const warn = vi.fn();
  const info = vi.fn();
  const log = { ...pino({ level: 'silent' }), warn, info } as never;
  const app = new Hono<ApiEnv>();
  enrichRoute(app, { db, env: {} as never, log, ...depsOverride });
  return { db, app, warn, info };
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

  // --- #369: relayed shop facts ---------------------------------------------

  it('persists a relayed abv and style on a newly created orphan', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'AleBrowar', name: 'KWAS CHLEBOWY JASNY', abv: 0, style: 'Kwas Chlebowy' }],
    });
    expect(res.status).toBe(200);
    const row = findBeerByNormalized(db, normalizeBrewery('AleBrowar'), normalizeName('KWAS CHLEBOWY JASNY'))!;
    expect(row.abv).toBe(0); // 0.0% must survive — it is the #322 disambiguator
    expect(row.style).toBe('Kwas Chlebowy');
  });

  it('backfills an existing orphan that had no abv, and re-arms its backoff', async () => {
    const { db, app } = setup();
    await post(app, '/enrich/candidates', { beers: [{ brewery: 'AleBrowar', name: 'KWAS CHLEBOWY JASNY' }] });
    const before = findBeerByNormalized(db, normalizeBrewery('AleBrowar'), normalizeName('KWAS CHLEBOWY JASNY'))!;
    db.prepare('UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = 3 WHERE id = ?')
      .run(new Date().toISOString(), before.id);

    await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'AleBrowar', name: 'KWAS CHLEBOWY JASNY', abv: 0 }],
    });

    const after = getBeer(db, before.id)!;
    expect(after.abv).toBe(0);
    expect(after.untappd_lookup_count).toBe(0);
    expect(after.untappd_lookup_at).toBeNull();
  });

  it('does not re-arm on a style-only gain', async () => {
    const { db, app } = setup();
    await post(app, '/enrich/candidates', { beers: [{ brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1 }] });
    const before = findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Atak Chmielu'))!;
    db.prepare('UPDATE beers SET untappd_lookup_count = 2 WHERE id = ?').run(before.id);

    await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1, style: 'IPA' }],
    });

    const after = getBeer(db, before.id)!;
    expect(after.style).toBe('IPA');
    expect(after.untappd_lookup_count).toBe(2);
  });

  it('drops an out-of-range abv instead of rejecting the whole batch', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [
        { brewery: 'PINTA', name: 'Bad Abv', abv: 9999 },
        { brewery: 'PINTA', name: 'Good Abv', abv: 5.2 },
      ],
    });
    expect(res.status).toBe(200);
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Bad Abv'))!.abv).toBeNull();
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Good Abv'))!.abv).toBe(5.2);
  });

  it('still accepts an old-shape body with no abv or style', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', { beers: [{ brewery: 'PINTA', name: 'Atak Chmielu' }] });
    expect(res.status).toBe(200);
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Atak Chmielu'))!.abv).toBeNull();
  });

  it('rejects a style over the per-field character limit', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Atak Chmielu', style: 's'.repeat(BEER_TEXT_LIMIT_CHARS + 1) }],
    });
    expect(res.status).toBe(413);
  });

  // --- #384: a shop-published bid that contradicts the stored link ----------------
  //
  // Without this, a wrongly-linked row is never offered as a candidate and the repair
  // path in /enrich/result is unreachable. The gate here must agree exactly with the
  // one there — same refusesBidOverride helper — so a link that would be refused is
  // never offered in the first place.

  function linkedRow(db: ReturnType<typeof setup>['db'], untappd_id: number, source?: string) {
    return upsertBeer(db, {
      untappd_id, name: 'Tomatol Bulgogi', brewery: 'Mad Brew',
      style: null, abv: null, rating_global: 3.7,
      normalized_name: normalizeName('Tomatol Bulgogi'),
      normalized_brewery: normalizeBrewery('Mad Brew'),
      ...(source ? { untappd_id_source: source as 'search' } : {}),
    });
  }

  const candidatesForMadBrew = (app: Hono<ApiEnv>, bid?: number) =>
    post(app, '/enrich/candidates', {
      beers: [{ brewery: 'Mad Brew', name: 'Tomatol Bulgogi', ...(bid !== undefined ? { bid } : {}) }],
    });

  it('is eligible when a published bid contradicts a link we guessed ourselves', async () => {
    const { db, app } = setup();
    linkedRow(db, 6708599, 'search');
    const body = await (await candidatesForMadBrew(app, 6648348)).json();
    expect(body.candidates[0].eligible).toBe(true);
  });

  it.each(['curated', 'checkin'])(
    'is not eligible when the stored link is %s — the same links /enrich/result refuses',
    async (source) => {
      const { db, app } = setup();
      linkedRow(db, 6708599, source);
      const body = await (await candidatesForMadBrew(app, 6648348)).json();
      expect(body.candidates[0].eligible).toBe(false);
    },
  );

  it('is eligible when the stored link predates provenance stamping (NULL source)', async () => {
    const { db, app } = setup();
    linkedRow(db, 6708599);
    const body = await (await candidatesForMadBrew(app, 6648348)).json();
    expect(body.candidates[0].eligible).toBe(true);
  });

  it('is not eligible when the published bid agrees with the stored link', async () => {
    const { db, app } = setup();
    linkedRow(db, 6708599, 'search');
    const body = await (await candidatesForMadBrew(app, 6708599)).json();
    expect(body.candidates[0].eligible).toBe(false);
  });

  it('is not eligible for a linked row when the shop publishes no bid', async () => {
    const { db, app } = setup();
    linkedRow(db, 6708599, 'search');
    const body = await (await candidatesForMadBrew(app)).json();
    expect(body.candidates[0].eligible).toBe(false);
  });

  // The backoff still gates a contradicted link — for rows that have a recorded lookup
  // attempt. A bid /enrich/result rejects records nothing, so that path is bounded by the
  // extension's badge cache instead; see the route comment.
  it('still applies the lookup backoff to a contradicted link', async () => {
    const { db, app } = setup();
    const id = linkedRow(db, 6708599, 'search');
    db.prepare('UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = 1 WHERE id = ?')
      .run(new Date(Date.now() - 3600_000).toISOString(), id);
    const body = await (await candidatesForMadBrew(app, 6648348)).json();
    expect(body.candidates[0].eligible).toBe(false);
  });

  it('still applies the wontfix triage veto to a contradicted link', async () => {
    const { db, app } = setup();
    const id = linkedRow(db, 6708599, 'search');
    recordEnrichFailure(db, {
      beer_id: id, brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: new Date().toISOString(),
    });
    setEnrichFailureReview(db, id, 'wontfix', null, new Date().toISOString());
    const body = await (await candidatesForMadBrew(app, 6648348)).json();
    expect(body.candidates[0].eligible).toBe(false);
  });

  it('rejects a non-positive bid rather than treating it as a contradiction', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'Mad Brew', name: 'Tomatol Bulgogi', bid: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it('keeps a 200-beer payload with abv and style inside the route byte limit', () => {
    const beers = Array.from({ length: 200 }, (_, i) => ({
      brewery: 'Browar Stu Mostow Wroclaw',
      name: `Salamander Imperial Baltic Porter Batch ${i}`,
      abv: 12.5,
      style: 'Baltic Porter - Imperial',
    }));
    const bytes = Buffer.byteLength(JSON.stringify({ beers }), 'utf8');
    expect(bytes).toBeLessThan(ENRICH_CANDIDATES_BODY_LIMIT_BYTES);
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

  it('applies web fallback on /enrich/result when the relayed search is empty', async () => {
    const webFallback = async () => ({
      bid: 5158585,
      beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      style: null, abv: 11.5, global_rating: null,
    });
    const { db, app } = setup({ webFallback });
    const res = await post(app, '/enrich/result', {
      brewery: 'Maryensztadt',
      name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon',
      algolia: { hits: [] }, // relayed 0 candidates
      pageUrl: 'https://shop.example/x',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'matched', untappd_id: 5158585 });

    const row = findBeerByNormalized(
      db, normalizeBrewery('Maryensztadt'), normalizeName('Ice Brett Porter Double BA Suszona Śliwka i Cynamon'),
    )!;
    expect(getBeer(db, row.id)!.untappd_id).toBe(5158585);
  });

  it('reports matched with the canonical bid when the relay result merges a duplicate', async () => {
    const { db, app } = setup();
    // A different row already owns bid 5469263 → recordLookupSuccess will hit the
    // UNIQUE constraint and merge the freshly created orphan into it.
    upsertBeer(db, {
      untappd_id: 5469263, name: 'Legacy Row', brewery: 'Legacy Brewery',
      style: null, abv: null, rating_global: 3.5,
      normalized_name: normalizeName('Legacy Row'),
      normalized_brewery: normalizeBrewery('Legacy Brewery'),
    });

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
    // Before #351 this answered {status:'not_found'} and the extension showed no
    // badge for a beer that IS on Untappd.
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 5469263 });
    // The orphan row is gone; the canonical keeps the bid.
    expect(findBeerByNormalized(
      db, normalizeBrewery('PINTA Barrel Brewing'), normalizeName('After Hours: Rose Wild Ale'),
    )).toBeNull();
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

  // --- #369: relayed shop facts ---------------------------------------------

  it('passes a relayed abv of 0 into the lookup rather than NULL', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/result', {
      brewery: 'AleBrowar',
      name: 'KWAS CHLEBOWY JASNY',
      abv: 0,
      style: 'Kwas Chlebowy',
      algolia: { hits: [], nbHits: 0 },
    });
    expect(res.status).toBe(200);
    const row = findBeerByNormalized(db, normalizeBrewery('AleBrowar'), normalizeName('KWAS CHLEBOWY JASNY'))!;
    expect(row.abv).toBe(0);
    expect(row.style).toBe('Kwas Chlebowy');
  });

  it('still accepts an old-shape result body with no abv or style', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/result', {
      brewery: 'PINTA', name: 'Atak Chmielu', algolia: { hits: [], nbHits: 0 },
    });
    expect(res.status).toBe(200);
  });
});

// --- #384: the shop-published Untappd bid ------------------------------------
//
// flasker publishes untappd.com/b/<slug>/<bid> on its product pages. When the shop
// tells us the identity, that beats guessing — but only over a link WE guessed.
const BULGOGI = {
  bid: 6648348,
  beer_name: 'Tomatøl:BULDAK BULGOGI',
  brewery_name: 'Mad Brew',
  brewery_alias: ['madbrew'],
  beer_slug: 'mad-brew-tomatol-buldak-bulgogi',
  style: 'Sour - Tomato / Vegetable Gose',
  abv: 4.2,
  global_rating: 4.06,
};
const hydrateBulgogi = () => vi.fn(async () => new Map([[BULGOGI.bid, BULGOGI]]));

const shopRowInput = (over: Record<string, unknown> = {}) => ({
  name: 'Tomatol Bulgogi', brewery: 'Mad Brew',
  normalized_name: normalizeName('Tomatol Bulgogi'),
  normalized_brewery: normalizeBrewery('Mad Brew'),
  ...over,
});
const sourceOf = (db: ReturnType<typeof openDb>, id: number) =>
  (db.prepare('SELECT untappd_id, untappd_id_source FROM beers WHERE id = ?').get(id) as
    | { untappd_id: number | null; untappd_id_source: string | null }
    | undefined);

describe('POST /enrich/result — published bid (#384)', () => {
  it('overrides a machine-derived link and merges into the canonical row', async () => {
    const { app, db, info } = setup({ hydrateByBid: hydrateBulgogi() });
    // The canonical row, as created by the check-ins sync.
    const canonical = upsertBeer(db, {
      untappd_id: 6648348, name: 'Tomatøl:BULDAK BULGOGI', brewery: 'Mad Brew',
      normalized_name: normalizeName('Tomatøl:BULDAK BULGOGI'),
      normalized_brewery: normalizeBrewery('Mad Brew'),
    });
    // The shop-identity row, wrongly matched by search.
    const shopRow = upsertBeer(db, shopRowInput({ untappd_id: 6708599, untappd_id_source: 'search' }));

    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi', abv: 3.8,
      bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi', brand: 'Mad Brew',
      algolia: { hits: [] },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6648348 });
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(shopRow)).toBeUndefined();
    expect(sourceOf(db, canonical)!.untappd_id).toBe(6648348);
    // The accepted line names what it replaced — the only trace of a repaired link.
    expect(info.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ bid: 6648348, source: 'local', replaced: 6708599 }),
    );
  });

  it.each(['curated', 'checkin'] as const)('refuses to override a %s link', async (source) => {
    const { app, db } = setup({ hydrateByBid: hydrateBulgogi() });
    const protectedRow = upsertBeer(db, shopRowInput({ untappd_id: 6708599, untappd_id_source: source }));
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Mad Brew', algolia: { hits: [] },
    });
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6708599 });
    expect(sourceOf(db, protectedRow)).toEqual({ untappd_id: 6708599, untappd_id_source: source });
  });

  // Regression guard for the relaxed early return: every client in production today
  // sends no bid, and must see byte-for-byte the old behaviour.
  it('is unchanged for a client that sends no bid', async () => {
    const { app, db } = setup({ hydrateByBid: hydrateBulgogi() });
    const row = upsertBeer(db, shopRowInput({
      untappd_id: 6708599, untappd_id_source: 'search', rating_global: 3.1,
    }));
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi', algolia: { hits: [] },
    });
    expect(await res.json()).toEqual({ status: 'matched', untappd_id: 6708599, rating_global: 3.1 });
    expect(sourceOf(db, row)).toEqual({ untappd_id: 6708599, untappd_id_source: 'search' });
  });

  // A request that carries the SAME bid as the stored link is not an override —
  // it must take the cheap early return, not re-resolve and re-write.
  it('takes the early return when the bid agrees with the stored link', async () => {
    const hydrate = hydrateBulgogi();
    const { app, db } = setup({ hydrateByBid: hydrate });
    const row = upsertBeer(db, shopRowInput({ untappd_id: 6648348, untappd_id_source: 'search' }));
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Mad Brew', algolia: { hits: [] },
    });
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6648348 });
    expect(hydrate).not.toHaveBeenCalled();
    expect(sourceOf(db, row)).toEqual({ untappd_id: 6648348, untappd_id_source: 'search' });
  });

  // The spec claims search cannot clobber a bid-sourced link "by construction",
  // because the early return fires for any request that carries no bid. Assert it
  // rather than trusting the prose.
  it('a later search cannot clobber a bid-sourced link', async () => {
    const { app, db } = setup({ hydrateByBid: hydrateBulgogi() });
    const row = upsertBeer(db, shopRowInput({ untappd_id: 6648348, untappd_id_source: 'bid' }));
    // A relay carrying search candidates but no bid — the pre-0.14 shape.
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      algolia: { hits: [{ bid: 6708599, beer_name: 'Tomatol: Bulgogi Sriracha', brewery_name: 'Mad Brew' }] },
    });
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6648348 });
    expect(sourceOf(db, row)).toEqual({ untappd_id: 6648348, untappd_id_source: 'bid' });
  });

  it('links an orphan straight from the bid, stamps provenance, and logs the divergences', async () => {
    const hydrate = hydrateBulgogi();
    const { app, db, info } = setup({ hydrateByBid: hydrate });
    const orphan = upsertBeer(db, shopRowInput({ untappd_id: null }));

    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi', abv: 3.8,
      bid: 6648348, bidSlug: 'mad-brew-tomatol-bulgogi', brand: 'Mad Brew',
      algolia: { hits: [] },
    });

    expect(await res.json()).toEqual({ status: 'matched', untappd_id: 6648348, rating_global: 4.06 });
    expect(hydrate).toHaveBeenCalledWith([6648348]);
    expect(sourceOf(db, orphan)).toEqual({ untappd_id: 6648348, untappd_id_source: 'bid' });
    // notes are the ONLY signal that would ever surface a same-brewery wrong bid.
    expect(info.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({
        bid: 6648348, source: 'hydrated',
        notes: ['slug-divergence', 'name-divergence', 'abv-divergence'],
      }),
    );
  });

  // Provenance may be raised by a bid, never lowered: merging into a check-in-sourced
  // canonical row must not restamp it 'bid' and thereby make it overridable.
  it('does not weaken the canonical row\'s stamp when merging into it', async () => {
    const { app, db } = setup({ hydrateByBid: hydrateBulgogi() });
    const canonical = upsertBeer(db, {
      untappd_id: 6648348, name: 'Tomatøl:BULDAK BULGOGI', brewery: 'Mad Brew',
      normalized_name: normalizeName('Tomatøl:BULDAK BULGOGI'),
      normalized_brewery: normalizeBrewery('Mad Brew'),
      untappd_id_source: 'checkin',
    });
    upsertBeer(db, shopRowInput({ untappd_id: 6708599, untappd_id_source: 'search' }));

    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Mad Brew', algolia: { hits: [] },
    });

    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 6648348 });
    expect(sourceOf(db, canonical)).toEqual({ untappd_id: 6648348, untappd_id_source: 'checkin' });
  });

  it('falls through to the normal pipeline when the guard vetoes', async () => {
    const { app, db, warn } = setup({ hydrateByBid: hydrateBulgogi() });
    const orphan = upsertBeer(db, {
      untappd_id: null, name: 'Tomatol Bulgogi', brewery: 'Browar Stu Mostów',
      normalized_name: normalizeName('Tomatol Bulgogi'),
      normalized_brewery: normalizeBrewery('Browar Stu Mostów'),
    });
    const res = await post(app, '/enrich/result', {
      brewery: 'Browar Stu Mostów', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Browar Stu Mostów', algolia: { hits: [] },
    });
    // Guard vetoes on brewery, normal pipeline finds nothing → orphan, not a wrong link.
    expect(await res.json()).toMatchObject({ status: 'not_found' });
    expect(sourceOf(db, orphan)).toEqual({ untappd_id: null, untappd_id_source: null });
    // Logged with both breweries: this is the alias blind spot, and it has to be
    // measurable in production rather than invisible.
    expect(warn.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({
        bid: 6648348, reason: 'brewery-mismatch',
        brand: 'Browar Stu Mostów', recordBrewery: 'Mad Brew',
      }),
    );
  });

  it('falls through and logs the underlying error when hydration fails', async () => {
    const err = new Error('403 blocked');
    const { app, db, warn } = setup({ hydrateByBid: vi.fn(async () => { throw err; }) });
    const orphan = upsertBeer(db, shopRowInput({ untappd_id: null }));

    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Mad Brew',
      algolia: {
        hits: [{ bid: 4242, beer_name: 'Tomatol Bulgogi', brewery_name: 'Mad Brew', rating_score: 3.2 }],
      },
    });

    // Never a request error, and never worse than today: the search pipeline still runs.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 4242 });
    expect(sourceOf(db, orphan)).toEqual({ untappd_id: 4242, untappd_id_source: 'search' });
    expect(warn.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ bid: 6648348, reason: 'hydrate-failed', err }),
    );
  });

  // Falling through to search would let a transient Untappd block turn "keep the
  // stored link" into "re-guess it" — strictly worse than before this feature.
  it('keeps an existing link when the bid fails to resolve, instead of re-guessing', async () => {
    const { app, db } = setup({ hydrateByBid: vi.fn(async () => { throw new Error('403 blocked'); }) });
    const row = upsertBeer(db, shopRowInput({
      untappd_id: 6708599, untappd_id_source: 'search', rating_global: 3.1,
    }));
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Mad Brew',
      algolia: {
        hits: [{ bid: 4242, beer_name: 'Tomatol Bulgogi', brewery_name: 'Mad Brew', rating_score: 3.2 }],
      },
    });
    expect(await res.json()).toEqual({ status: 'matched', untappd_id: 6708599, rating_global: 3.1 });
    expect(sourceOf(db, row)).toEqual({ untappd_id: 6708599, untappd_id_source: 'search' });
  });

  it('falls through when no hydrate function is wired and the bid is unknown locally', async () => {
    const { app, db } = setup(); // no hydrateByBid dep at all
    const orphan = upsertBeer(db, shopRowInput({ untappd_id: null }));
    const res = await post(app, '/enrich/result', {
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, brand: 'Mad Brew', algolia: { hits: [] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'not_found' });
    expect(sourceOf(db, orphan)).toEqual({ untappd_id: null, untappd_id_source: null });
  });

  it('rejects a non-positive or non-integer bid at schema validation', async () => {
    const { app } = setup({ hydrateByBid: hydrateBulgogi() });
    for (const bid of [0, -1, 1.5]) {
      const res = await post(app, '/enrich/result', {
        brewery: 'Mad Brew', name: 'Tomatol Bulgogi', bid, algolia: { hits: [] },
      });
      expect(res.status).toBe(400);
    }
  });
});

// #369 review follow-up: one malformed card must never 400 a 200-beer batch. JSON
// serializes NaN/Infinity as null, so null has to be tolerated and dropped, not rejected.
describe('enrich payload tolerance', () => {
  it('accepts a null abv on /enrich/candidates and drops it instead of rejecting the batch', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [
        { brewery: 'PINTA', name: 'Null Abv', abv: null },
        { brewery: 'PINTA', name: 'Good Abv', abv: 5.2 },
      ],
    });
    expect(res.status).toBe(200);
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Null Abv'))!.abv).toBeNull();
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Good Abv'))!.abv).toBe(5.2);
  });

  it('accepts a null style without rejecting the batch', async () => {
    const { db, app } = setup();
    const res = await post(app, '/enrich/candidates', {
      beers: [{ brewery: 'PINTA', name: 'Null Style', style: null }],
    });
    expect(res.status).toBe(200);
    expect(findBeerByNormalized(db, normalizeBrewery('PINTA'), normalizeName('Null Style'))!.style).toBeNull();
  });

  it('accepts a null abv on /enrich/result', async () => {
    const { app } = setup();
    const res = await post(app, '/enrich/result', {
      brewery: 'PINTA', name: 'Null Abv', abv: null, style: null, algolia: { hits: [], nbHits: 0 },
    });
    expect(res.status).toBe(200);
  });
});
