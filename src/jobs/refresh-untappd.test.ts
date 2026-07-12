import { vi } from 'vitest';
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { ensureProfile, setUntappdUsername } from '../storage/user_profiles';
import { HttpError, type Http } from '../sources/http';
import { refreshAllUntappd } from './refresh-untappd';
import { createCircuitBreaker } from '../domain/untappd-circuit';
import { catalogVersion } from '../storage/catalog-version';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function fakeHttp(htmlByUrl: Record<string, string>): Http {
  return {
    async get(url: string): Promise<string> {
      const v = htmlByUrl[url];
      if (v == null) throw new Error(`unexpected url: ${url}`);
      return v;
    },
  };
}

const PAGE_ONE_BEER = (bid: number, name: string, brewery: string, global: string) => `
  <div class="beer-item" data-bid="${bid}">
    <div class="beer-details">
      <p class="name"><a href="/b/x/${bid}">${name}</a></p>
      <p class="brewery"><a href="/x">${brewery}</a></p>
      <p class="style">IPA</p>
      <div class="ratings">
        <div class="you">
          <p>Their Rating (4)</p>
          <div class="caps" data-rating="4"></div>
        </div>
        <div class="you">
          <p>Global Rating (${global})</p>
          <div class="caps" data-rating="${global}"></div>
        </div>
      </div>
    </div>
  </div>`;

const PAGE_ONE_BEER_ABV = (
  bid: number, name: string, brewery: string, global: string, abv: string,
) => `
  <div class="beer-item" data-bid="${bid}">
    <div class="beer-details">
      <p class="name"><a href="/b/x/${bid}">${name}</a></p>
      <p class="brewery"><a href="/x">${brewery}</a></p>
      <p class="style">IPA</p>
      <div class="ratings">
        <div class="you">
          <p>Global Rating (${global})</p>
          <div class="caps" data-rating="${global}"></div>
        </div>
      </div>
    </div>
    <p class="abv">${abv}</p>
  </div>`;

// IMPORTANT for test names: `normalizeBrewery` strips tokens
// `brewing/brewery/co/company/browar`; `normalizeName` strips style words
// like `ipa/lager/stout/...`. Keep test fixtures clear of those tokens
// so the normalized form matches the literal lowercased input.

describe('refreshAllUntappd', () => {
  test('inserts a new beer with rating_global from /beers', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const http = fakeHttp({
      'https://untappd.com/user/someone/beers': PAGE_ONE_BEER(101, 'Atak Chmielu', 'Pinta', '4.12'),
    });

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'pinta', 'atak chmielu');
    expect(row).not.toBeNull();
    expect(row!.untappd_id).toBe(101);
    expect(row!.rating_global).toBe(4.12);
    expect(row!.abv).toBeNull();
    expect(row!.style).toBe('IPA');
  });

  test('inserts a new beer with abv parsed from /beers', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const http = fakeHttp({
      'https://untappd.com/user/someone/beers':
        PAGE_ONE_BEER_ABV(300, 'Gardees', 'Malpolon', '3.85', '8.4% ABV'),
    });

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'malpolon', 'gardees')!;
    expect(row.untappd_id).toBe(300);
    expect(row.abv).toBe(8.4);
  });

  test('backfills abv on an existing matched beer whose abv was NULL', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const seededId = upsertBeer(db, {
      untappd_id: 6400148,
      name: 'Gardees',
      brewery: 'Malpolon',
      style: 'Farmhouse Ale',
      abv: null,
      rating_global: 3.85,
      normalized_name: 'gardees',
      normalized_brewery: 'malpolon',
    });

    const http = fakeHttp({
      'https://untappd.com/user/someone/beers':
        PAGE_ONE_BEER_ABV(6400148, 'Gardees', 'Malpolon', '3.90', '8.4% ABV'),
    });

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'malpolon', 'gardees')!;
    expect(row.id).toBe(seededId);
    expect(row.abv).toBe(8.4);
    expect(row.rating_global).toBe(3.90);
  });

  test('matches existing row by normalized name+brewery; updates rating_global only', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const seededId = upsertBeer(db, {
      untappd_id: null,
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: 'NEIPA — Hazy',
      abv: 6.5,
      rating_global: null,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });

    const http = fakeHttp({
      'https://untappd.com/user/someone/beers': PAGE_ONE_BEER(101, 'Atak Chmielu', 'Pinta', '4.20'),
    });

    const v = catalogVersion();
    await refreshAllUntappd({ db, log: silentLog, http });
    expect(catalogVersion()).toBeGreaterThan(v);

    const row = findBeerByNormalized(db, 'pinta', 'atak chmielu')!;
    expect(row.id).toBe(seededId);
    expect(row.rating_global).toBe(4.20);
    expect(row.style).toBe('NEIPA — Hazy');
    expect(row.abv).toBe(6.5);
    expect(row.name).toBe('Atak Chmielu');
    expect(row.brewery).toBe('Pinta');
    expect(row.untappd_id).toBeNull();
  });

  test('global_rating null on /beers → row.rating_global set to NULL (idempotent re-read)', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const seededId = upsertBeer(db, {
      untappd_id: null,
      name: 'Brand New Release',
      brewery: 'New Brews',
      style: 'Lager',
      abv: 5.0,
      rating_global: 3.9,
      normalized_name: 'brand new release',
      normalized_brewery: 'new brews',
    });

    const html = `
      <div class="beer-item" data-bid="555">
        <div class="beer-details">
          <p class="name"><a href="/b/x/555">Brand New Release</a></p>
          <p class="brewery"><a href="/x">New Brews</a></p>
          <p class="style">Lager</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (5)</p>
              <div class="caps" data-rating="5"></div>
            </div>
            <div class="you">
              <p>Global Rating (N/A)</p>
              <div class="caps" data-rating="N/A"></div>
            </div>
          </div>
        </div>
      </div>`;
    const http = fakeHttp({ 'https://untappd.com/user/someone/beers': html });

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'new brews', 'brand new release')!;
    expect(row.id).toBe(seededId);
    expect(row.rating_global).toBeNull();
  });

  test('hits /beers (plural), not /beer (singular)', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string) {
        seenUrls.push(url);
        return '';
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http });
    expect(seenUrls).toEqual(['https://untappd.com/user/someone/beers']);
  });

  test('skips profiles with no untappd_username', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'real');

    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string) {
        seenUrls.push(url);
        return '';
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http });
    expect(seenUrls).toEqual(['https://untappd.com/user/real/beers']);
  });

  test('breaker open: skips the whole profile scrape without HTTP', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    const T = new Date('2026-06-25T03:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => {},
      onRecover: () => {},
    });
    breaker.onResult(true, T);
    const http: Http = { get: vi.fn(async () => PAGE_ONE_BEER(1, 'No Call', 'No Brew', '3.1')) };

    await refreshAllUntappd({
      db, log: silentLog, http, breaker,
      now: () => new Date(T.getTime() + 3600_000),
    });

    expect(http.get).not.toHaveBeenCalled();
    expect(breaker.state).toBe('open');
  });

  test('profile scrape 403 trips breaker and stops remaining users', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'bob');
    const events: string[] = [];
    const T = new Date('2026-06-25T03:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => events.push('trip'),
      onRecover: () => events.push('recover'),
    });
    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string) {
        seenUrls.push(url);
        throw new HttpError(403, url);
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http, breaker, now: () => T });

    expect(seenUrls).toEqual(['https://untappd.com/user/alice/beers']);
    expect(events).toEqual(['trip']);
    expect(breaker.state).toBe('open');
  });

  test('profile scrape captcha page trips breaker', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    const events: string[] = [];
    const T = new Date('2026-06-25T03:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => events.push('trip'),
      onRecover: () => events.push('recover'),
    });
    const http: Http = {
      async get() {
        return '<html><title>Just a moment...</title><body>cf-challenge</body></html>';
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http, breaker, now: () => T });

    expect(events).toEqual(['trip']);
    expect(breaker.state).toBe('open');
    expect(findBeerByNormalized(db, 'anything', 'anything')).toBeNull();
  });

  test('survives a per-profile fetch error and continues', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'broken');
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'someone');

    const http: Http = {
      async get(url: string) {
        if (url.includes('broken')) throw new Error('HTTP 503');
        return PAGE_ONE_BEER(202, 'Survivor Hazy', 'Steady Brews', '3.50');
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http });

    const row = findBeerByNormalized(db, 'steady brews', 'survivor hazy');
    expect(row).not.toBeNull();
    expect(row!.rating_global).toBe(3.50);
  });

  test('marks each scraped beer in untappd_had for that user', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const html = `
      ${PAGE_ONE_BEER(101, 'Atak Chmielu', 'Pinta', '4.12')}
      ${PAGE_ONE_BEER(202, 'Buty Skejta', 'Stu Mostow', '3.5')}`;
    const http = fakeHttp({
      'https://untappd.com/user/someone/beers': html,
    });

    await refreshAllUntappd({ db, log: silentLog, http });

    const rows = db
      .prepare('SELECT telegram_id, beer_id FROM untappd_had ORDER BY beer_id')
      .all() as { telegram_id: number; beer_id: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.telegram_id === 1)).toBe(true);

    const atak = findBeerByNormalized(db, 'pinta', 'atak chmielu')!;
    const buty = findBeerByNormalized(db, 'stu mostow', 'buty skejta')!;
    expect(new Set(rows.map((r) => r.beer_id))).toEqual(new Set([atak.id, buty.id]));
  });

  test('CookieExpiredError: calls notifyAdmin once and stops processing further users', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'bob');

    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string) {
        seenUrls.push(url);
        const { CookieExpiredError: E } = await import('../sources/http');
        throw new E();
      },
    };
    const notifyAdmin = vi.fn(async () => {});

    await refreshAllUntappd({ db, log: silentLog, http, notifyAdmin });

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith(expect.stringContaining('cookie'));
    expect(seenUrls).toHaveLength(1); // stopped after first user
  });

  test('CookieExpiredError does not trip the VPS circuit by itself', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    const events: string[] = [];
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => events.push('trip'),
      onRecover: () => events.push('recover'),
    });
    const { CookieExpiredError: E } = await import('../sources/http');
    const http: Http = { async get() { throw new E(); } };

    await refreshAllUntappd({ db, log: silentLog, http, breaker });

    expect(events).toEqual([]);
    expect(breaker.state).toBe('closed');
  });

  test('blockThreshold > 1: a single block page does not stop remaining profiles', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');
    ensureProfile(db, 2);
    setUntappdUsername(db, 2, 'bob');
    const T = new Date('2026-06-25T03:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => {},
      onRecover: () => {},
      blockThreshold: 2,
    });
    const seenUrls: string[] = [];
    const http: Http = {
      async get(url: string): Promise<string> {
        seenUrls.push(url);
        if (url.includes('alice')) {
          // Cloudflare block page for alice
          return '<html><title>Just a moment...</title><body>cf-challenge</body></html>';
        }
        // Valid page for bob — one beer so we can assert processing continued
        return PAGE_ONE_BEER(303, 'Survivor Ale', 'Steady Hops', '3.80');
      },
    };

    await refreshAllUntappd({ db, log: silentLog, http, breaker, now: () => T });

    // Both profiles were fetched — loop did NOT stop after alice's block
    expect(seenUrls).toContain('https://untappd.com/user/alice/beers');
    expect(seenUrls).toContain('https://untappd.com/user/bob/beers');
    // Bob's beer was upserted
    expect(findBeerByNormalized(db, 'steady hops', 'survivor ale')).not.toBeNull();
    // Breaker is still closed (only 1 block, threshold is 2)
    expect(breaker.state).toBe('closed');
  });

  test('CookieExpiredError without notifyAdmin does not throw', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'alice');

    const { CookieExpiredError: E } = await import('../sources/http');
    const http: Http = { async get() { throw new E(); } };

    // should resolve (not throw) regardless of the return value shape
    await refreshAllUntappd({ db, log: silentLog, http });
  });

  test('returns rotated as the http.rotations() delta over the run', async () => {
    const db = fresh();
    const tg1 = 111, tg2 = 222;
    ensureProfile(db, tg1);
    setUntappdUsername(db, tg1, 'alice');
    ensureProfile(db, tg2);
    setUntappdUsername(db, tg2, 'bob');

    let rot = 0;
    const http: Http = {
      async get(url: string): Promise<string> {
        rot += 1; // simulate one absorbed (rotated + retried) block per request
        const bid = url.includes('alice') ? 1 : 2;
        return `<div>${PAGE_ONE_BEER(bid, `Beer${bid}`, `Brewer${bid}`, '4.0')}</div>`;
      },
      rotations: () => rot,
    };

    const result = await refreshAllUntappd({ db, log: silentLog, http });

    expect(result.rotated).toBe(2);
    expect(result.ok).toBe(2);
  });
});
