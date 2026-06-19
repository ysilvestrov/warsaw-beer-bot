import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import { HttpError, type Http } from '../sources/http';
import { refreshTapRatings } from './refresh-tap-ratings';
import { createCircuitBreaker } from '../domain/untappd-circuit';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function beerPageHtml(rating: string): string {
  return `<html><body>
    <div class="basic">
      <div class="rating">
        <div class="caps" data-rating="${rating}"></div>
      </div>
    </div>
  </body></html>`;
}

function seedIdBeerOnTap(
  db: ReturnType<typeof fresh>,
  brewery: string, name: string, untappdId: number,
): number {
  const beerId = upsertBeer(db, {
    untappd_id: untappdId,
    name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase(),
  });
  const pubId = upsertPub(db, {
    slug: `pub-${beerId}`, name: `Pub ${beerId}`,
    address: null, lat: null, lon: null, city: 'warszawa',
  });
  const snapId = createSnapshot(db, pubId, '2026-05-27T12:00:00Z');
  const ref = `${brewery} ${name}`;
  upsertMatch(db, ref, beerId, 1.0);
  insertTaps(db, snapId, [{
    tap_number: 1, beer_ref: ref, brewery_ref: brewery,
    abv: null, ibu: null, style: null, u_rating: null,
  }]);
  return beerId;
}

describe('refreshTapRatings', () => {
  test('matched: fills rating_global and stats it as matched', async () => {
    const db = fresh();
    const beerId = seedIdBeerOnTap(db, 'Magic Road', 'Clementine', 6645513);
    const calls: string[] = [];
    const http: Http = {
      async get(url: string): Promise<string> {
        calls.push(url);
        return beerPageHtml('3.98');
      },
    };
    const fixedNow = new Date('2026-05-27T12:00:00Z');

    const result = await refreshTapRatings({
      db, log: silentLog, http, sleepMs: 0, now: () => fixedNow,
    });

    expect(result).toEqual({
      processed: 1, matched: 1, not_found: 0, transient: 0, blocked: 0,
    });
    expect(calls).toEqual(['https://untappd.com/beer/6645513']);
    expect(getBeer(db, beerId)?.rating_global).toBeCloseTo(3.98);
  });

  test('not_found: NULL rating bumps count + records refresh_at', async () => {
    const db = fresh();
    const beerId = seedIdBeerOnTap(db, 'Brand', 'New', 999);
    const http: Http = {
      async get(): Promise<string> { return beerPageHtml('N/A'); },
    };
    const fixedNow = new Date('2026-05-27T12:00:00Z');

    const result = await refreshTapRatings({
      db, log: silentLog, http, sleepMs: 0, now: () => fixedNow,
    });

    expect(result).toEqual({
      processed: 1, matched: 0, not_found: 1, transient: 0, blocked: 0,
    });
    const row = getBeer(db, beerId);
    expect(row?.rating_global).toBeNull();
    expect(row?.rating_refresh_count).toBe(1);
    expect(row?.rating_refresh_at).toBe('2026-05-27T12:00:00.000Z');
  });

  test('transient: HTTP error records refresh_at without incrementing count', async () => {
    const db = fresh();
    const beerId = seedIdBeerOnTap(db, 'X', 'Y', 100);
    const http: Http = {
      async get(): Promise<string> { throw new Error('ETIMEDOUT'); },
    };
    const fixedNow = new Date('2026-05-27T12:00:00Z');

    const result = await refreshTapRatings({
      db, log: silentLog, http, sleepMs: 0, now: () => fixedNow,
    });

    expect(result).toEqual({
      processed: 1, matched: 0, not_found: 0, transient: 1, blocked: 0,
    });
    const row = getBeer(db, beerId);
    expect(row?.rating_refresh_count).toBe(0);
    expect(row?.rating_refresh_at).toBe('2026-05-27T12:00:00.000Z');
  });

  test('respects limit', async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedIdBeerOnTap(db, `Brew${i}`, `Beer${i}`, 100 + i);
    }
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> { calls++; return beerPageHtml('N/A'); },
    };
    const result = await refreshTapRatings({
      db, log: silentLog, http, limit: 2, sleepMs: 0,
      now: () => new Date('2026-05-27T12:00:00Z'),
    });
    expect(result.processed).toBe(2);
    expect(calls).toBe(2);
  });

  test('lookupEnabled=false: no candidates touched, no HTTP', async () => {
    const db = fresh();
    seedIdBeerOnTap(db, 'X', 'Y', 100);
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> { calls++; return ''; },
    };
    const result = await refreshTapRatings({
      db, log: silentLog, http, lookupEnabled: false, sleepMs: 0,
      now: () => new Date('2026-05-27T12:00:00Z'),
    });
    expect(result).toEqual({ processed: 0, matched: 0, not_found: 0, transient: 0, blocked: 0 });
    expect(calls).toBe(0);
  });

  test('sleeps between HTTP calls when sleepMs > 0', async () => {
    const db = fresh();
    seedIdBeerOnTap(db, 'A', 'B', 100);
    seedIdBeerOnTap(db, 'C', 'D', 200);
    const sleeps: number[] = [];
    const http: Http = {
      async get(): Promise<string> { return beerPageHtml('N/A'); },
    };
    const sleep = async (ms: number) => { sleeps.push(ms); };

    await refreshTapRatings({
      db, log: silentLog, http, sleepMs: 500, sleep,
      now: () => new Date('2026-05-27T12:00:00Z'),
    });
    expect(sleeps).toEqual([500]);
  });

  test('breaker open → run skipped, no HTTP', async () => {
    const db = fresh();
    seedIdBeerOnTap(db, 'Brew', 'Beer', 100);
    const T = new Date('2026-05-27T12:00:00Z');
    const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => {}, onRecover: () => {} });
    breaker.onResult(true, T);
    let calls = 0;
    const http: Http = { async get() { calls++; return ''; } };
    const res = await refreshTapRatings({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => new Date(T.getTime() + 3600_000) });
    expect(res.processed).toBe(0);
    expect(calls).toBe(0);
  });

  test('block (429) → trips breaker, does not record transient', async () => {
    const db = fresh();
    const beerId = seedIdBeerOnTap(db, 'Brew', 'Beer', 100);
    const events: string[] = [];
    const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => events.push('trip'), onRecover: () => {} });
    const http: Http = { async get() { throw new HttpError(429, 'u'); } };
    const res = await refreshTapRatings({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => new Date('2026-05-27T12:00:00Z') });
    expect(res.blocked).toBe(1);
    expect(res.transient).toBe(0);
    expect(breaker.state).toBe('open');
    expect(events).toEqual(['trip']);
    expect(getBeer(db, beerId)?.rating_refresh_count).toBe(0);
  });

  test('captcha page → blocked, not not_found', async () => {
    const db = fresh();
    seedIdBeerOnTap(db, 'Brew', 'Beer', 100);
    const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => {}, onRecover: () => {} });
    const http: Http = { async get() { return '<title>Just a moment...</title>'; } };
    const res = await refreshTapRatings({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => new Date('2026-05-27T12:00:00Z') });
    expect(res.blocked).toBe(1);
    expect(res.not_found).toBe(0);
  });
});
