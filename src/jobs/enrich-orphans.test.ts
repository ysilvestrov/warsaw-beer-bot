import { vi } from 'vitest';
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import { HttpError, type Http } from '../sources/http';
import { enrichOrphans } from './enrich-orphans';
import { createCircuitBreaker } from '../domain/untappd-circuit';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function searchHtml(items: Array<{ bid: number; name: string; brewery: string }>): string {
  const cards = items
    .map((it) => `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/${it.bid}">${it.name}</a></p>
          <p class="brewery"><a>${it.brewery}</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">5% ABV</p>
          <div class="rating"><div class="caps" data-rating="3.5"></div></div>
        </div>
      </div>`)
    .join('');
  return `<html><body>${cards}</body></html>`;
}

function seedOrphanOnTap(
  db: ReturnType<typeof fresh>,
  brewery: string,
  name: string,
): number {
  const beerId = upsertBeer(db, {
    name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase(),
  });
  const pubId = upsertPub(db, {
    slug: `pub-${beerId}`, name: `Pub ${beerId}`,
    address: null, lat: null, lon: null,
  });
  const snapId = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');
  const ref = `${brewery} ${name}`;
  upsertMatch(db, ref, beerId, 1.0);
  insertTaps(db, snapId, [{
    tap_number: 1, beer_ref: ref, brewery_ref: brewery,
    abv: null, ibu: null, style: null, u_rating: null,
  }]);
  return beerId;
}

describe('enrichOrphans', () => {
  test('processes orphans on current taps, returns stats', async () => {
    const db = fresh();
    const a = seedOrphanOnTap(db, 'Magic Road', 'Fifty Fifty Clementine');
    const b = seedOrphanOnTap(db, 'Magic Road', 'Buty Skejta');
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> {
        calls++;
        if (calls === 1) {
          return searchHtml([
            { bid: 100, name: 'Fifty Fifty Clementine', brewery: 'Magic Road' },
          ]);
        }
        return searchHtml([
          { bid: 200, name: 'Buty Skejta', brewery: 'Some Other Brewery' },
        ]);
      },
    };
    const fixedNow = new Date('2026-05-26T12:00:00Z');

    const result = await enrichOrphans({
      db, log: silentLog, http, sleepMs: 0, now: () => fixedNow,
    });

    expect(result.processed).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.not_found).toBe(1);
    expect(result.transient).toBe(0);
    expect(result.skipped).toBe(0);

    expect(getBeer(db, a)?.untappd_id).toBe(100);
    expect(getBeer(db, b)?.untappd_id).toBeNull();
    expect(getBeer(db, b)?.untappd_lookup_count).toBe(1);
  });

  test('respects limit', async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedOrphanOnTap(db, `Brew${i}`, `Beer${i}`);
    }
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> {
        calls++;
        return '<html><body></body></html>';
      },
    };

    const result = await enrichOrphans({
      db, log: silentLog, http, limit: 2, sleepMs: 0,
      now: () => new Date('2026-05-26T12:00:00Z'),
    });

    expect(result.processed).toBe(2);
    expect(calls).toBe(2);
  });

  test('lookupEnabled=false: no candidates touched, no HTTP', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'Brew', 'Beer');
    let calls = 0;
    const http: Http = {
      async get(): Promise<string> { calls++; return ''; },
    };

    const result = await enrichOrphans({
      db, log: silentLog, http, lookupEnabled: false, sleepMs: 0,
      now: () => new Date('2026-05-26T12:00:00Z'),
    });

    expect(result).toEqual({ processed: 0, matched: 0, not_found: 0, transient: 0, skipped: 0, blocked: 0 });
    expect(calls).toBe(0);
  });

  test('sleeps between HTTP calls when sleepMs > 0', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'A', 'B');
    seedOrphanOnTap(db, 'C', 'D');
    const sleeps: number[] = [];
    const http: Http = {
      async get(): Promise<string> { return '<html></html>'; },
    };
    const sleep = async (ms: number) => { sleeps.push(ms); };

    await enrichOrphans({
      db, log: silentLog, http, sleepMs: 500, sleep,
      now: () => new Date('2026-05-26T12:00:00Z'),
    });

    expect(sleeps).toEqual([500]);
  });

  function dbWithOrphans(n: number) {
    const db = fresh();
    for (let k = 0; k < n; k++) seedOrphanOnTap(db, `B${k}`, `N${k}`);
    return db;
  }
  const T = new Date('2026-06-04T00:00:00Z');

  test('breaker open → run skipped, ZERO result', async () => {
    const db = dbWithOrphans(2);
    const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => {}, onRecover: () => {} });
    breaker.onResult(true, T); // open
    const http = { get: vi.fn(async () => '<html></html>') };
    const res = await enrichOrphans({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => new Date(T.getTime() + 3600_000) });
    expect(res.processed).toBe(0);
    expect(http.get).not.toHaveBeenCalled();
  });

  test('block mid-run → trips breaker and stops', async () => {
    const db = dbWithOrphans(3);
    const events: string[] = [];
    const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => events.push('trip'), onRecover: () => {} });
    const http: Http = { get: async () => { throw new HttpError(403, 'u'); } };
    const res = await enrichOrphans({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => T });
    expect(res.blocked).toBe(1);
    expect(res.processed).toBe(1);
    expect(breaker.state).toBe('open');
    expect(events).toEqual(['trip']);
  });

  test('half-open probe success → recovers and continues', async () => {
    const db = dbWithOrphans(2);
    const events: string[] = [];
    const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => events.push('trip'), onRecover: () => events.push('recover') });
    breaker.onResult(true, T); // open
    const http: Http = { get: async () => '<html></html>' }; // no results → not_found, NOT blocked
    const res = await enrichOrphans({ db, log: silentLog, http, breaker, sleepMs: 0, now: () => new Date(T.getTime() + 6 * 3600_000) });
    expect(breaker.state).toBe('closed');
    expect(events).toContain('recover');
    expect(res.processed).toBe(2);
  });
});
