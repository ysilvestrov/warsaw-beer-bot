import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { ensureProfile, setUntappdUsername } from '../storage/user_profiles';
import type { Http } from '../sources/http';
import { refreshAllUntappd } from './refresh-untappd';

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

    await refreshAllUntappd({ db, log: silentLog, http });

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
});
