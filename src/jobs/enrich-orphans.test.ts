import { vi } from 'vitest';
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import { HttpError } from '../sources/http';
import type { SearchResult } from '../sources/untappd/search';
import { enrichOrphans, CANARY_QUERY, CANARY_STATE_KEY } from './enrich-orphans';
import { getJobState } from '../storage/job_state';
import { createCircuitBreaker } from '../domain/untappd-circuit';

const silentLog = pino({ level: 'silent' });

// A hit for the canary query that satisfies hits.length > 0.
const GUINNESS_HIT: SearchResult = {
  bid: 9999, beer_name: 'Guinness Draught', brewery_name: 'Guinness',
  style: null, abv: null, global_rating: null,
};

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
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
    address: null, lat: null, lon: null, city: 'warszawa',
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
    const search = {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [GUINNESS_HIT];
        calls++;
        if (calls === 1) {
          return [{ bid: 100, beer_name: 'Fifty Fifty Clementine', brewery_name: 'Magic Road', style: null, abv: null, global_rating: null }];
        }
        return [{ bid: 200, beer_name: 'Buty Skejta', brewery_name: 'Some Other Brewery', style: null, abv: null, global_rating: null }];
      },
    };
    const fixedNow = new Date('2026-05-26T12:00:00Z');

    const result = await enrichOrphans({
      db, log: silentLog, search, sleepMs: 0, now: () => fixedNow,
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
    const search = {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [GUINNESS_HIT];
        calls++;
        return [];
      },
    };

    const result = await enrichOrphans({
      db, log: silentLog, search, limit: 2, sleepMs: 0,
      now: () => new Date('2026-05-26T12:00:00Z'),
    });

    expect(result.processed).toBe(2);
    expect(calls).toBe(2);
  });

  test('lookupEnabled=false: no candidates touched, no search', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'Brew', 'Beer');
    let calls = 0;
    const search = {
      async search(): Promise<SearchResult[]> { calls++; return []; },
    };

    const result = await enrichOrphans({
      db, log: silentLog, search, lookupEnabled: false, sleepMs: 0,
      now: () => new Date('2026-05-26T12:00:00Z'),
    });

    expect(result).toEqual({ processed: 0, matched: 0, not_found: 0, transient: 0, skipped: 0, blocked: 0 });
    expect(calls).toBe(0);
  });

  test('sleeps between search calls when sleepMs > 0', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'A', 'B');
    seedOrphanOnTap(db, 'C', 'D');
    const sleeps: number[] = [];
    const search = {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [GUINNESS_HIT];
        return [];
      },
    };
    const sleep = async (ms: number) => { sleeps.push(ms); };

    await enrichOrphans({
      db, log: silentLog, search, sleepMs: 500, sleep,
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
    const search = { search: vi.fn(async (q: string): Promise<SearchResult[]> => {
      if (q === CANARY_QUERY) return [GUINNESS_HIT];
      return [];
    }) };
    const res = await enrichOrphans({ db, log: silentLog, search, breaker, sleepMs: 0, now: () => new Date(T.getTime() + 3600_000) });
    expect(res.processed).toBe(0);
    expect(search.search).not.toHaveBeenCalled();
  });

  test('block mid-run → trips breaker and stops', async () => {
    const db = dbWithOrphans(3);
    const events: string[] = [];
    const breaker = createCircuitBreaker({ cooldownMs: 6 * 3600_000, onTrip: () => events.push('trip'), onRecover: () => {} });
    const search = {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [GUINNESS_HIT];
        throw new HttpError(403, 'u');
      },
    };
    const res = await enrichOrphans({ db, log: silentLog, search, breaker, sleepMs: 0, now: () => T });
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
    const search = {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [GUINNESS_HIT];
        return []; // no results → not_found, NOT blocked
      },
    };
    const res = await enrichOrphans({ db, log: silentLog, search, breaker, sleepMs: 0, now: () => new Date(T.getTime() + 6 * 3600_000) });
    expect(breaker.state).toBe('closed');
    expect(events).toContain('recover');
    expect(res.processed).toBe(2);
  });

  test('blockThreshold > 1: a single block does not stop the run', async () => {
    const db = fresh();
    seedOrphanOnTap(db, 'Brew A', 'Beer A');
    seedOrphanOnTap(db, 'Brew B', 'Beer B');
    seedOrphanOnTap(db, 'Brew C', 'Beer C');
    let calls = 0;
    const search = {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [GUINNESS_HIT];
        calls++;
        if (calls === 1) throw new HttpError(403, 'u'); // first lookup blocked
        return [];                                        // rest: no results → not_found
      },
    };
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000, onTrip: () => {}, onRecover: () => {}, blockThreshold: 2,
    });
    const T = new Date('2026-05-26T12:00:00Z');
    const res = await enrichOrphans({ db, log: silentLog, search, breaker, sleepMs: 0, now: () => T });
    expect(res.blocked).toBe(1);
    expect(res.processed).toBe(3);        // loop continued past the first block
    expect(res.not_found).toBe(2);
    expect(breaker.state).toBe('closed'); // the two successes reset the counter
  });

  // --- Canary tests ---

  test('aborts the run and alerts when the canary returns no hits', async () => {
    const db = dbWithOrphans(3);
    const alerts: string[] = [];
    const search = {
      async search(q: string): Promise<SearchResult[]> {
        if (q === CANARY_QUERY) return [];
        return [GUINNESS_HIT]; // unreachable in this test, but satisfies the type
      },
    };
    const breaker = { canAttempt: () => true, onResult: vi.fn(), state: 'closed' as const };
    const res = await enrichOrphans({
      db, log: silentLog, search, breaker, notifyAdmin: async (m) => { alerts.push(m); }, sleepMs: 0,
    });
    expect(res.processed).toBe(0);
    expect(breaker.onResult).toHaveBeenCalledWith(true, expect.anything());
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(getJobState(db, CANARY_STATE_KEY)!).ok).toBe(false);
  });

  test('proceeds and records canary ok when the canary returns hits', async () => {
    const db = dbWithOrphans(2);
    const search = {
      async search(): Promise<SearchResult[]> {
        return [GUINNESS_HIT];
      },
    };
    const breaker = { canAttempt: () => true, onResult: vi.fn(), state: 'closed' as const };
    const res = await enrichOrphans({
      db, log: silentLog, search, breaker, sleepMs: 0,
    });
    expect(res.processed).toBeGreaterThan(0);
    expect(JSON.parse(getJobState(db, CANARY_STATE_KEY)!).ok).toBe(true);
  });
});
