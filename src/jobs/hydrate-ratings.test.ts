import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { getBeer } from '../storage/beers';
import { seedBeer } from '../storage/seed-beer.testing';
import { HttpError } from '../sources/http';
import type { HydratedBeer } from '../sources/untappd/search';
import type { CircuitBreaker } from '../domain/untappd-circuit';
import { hydrateRatings, RATING_HYDRATION_BATCH } from './hydrate-ratings';

const silentLog = pino({ level: 'silent' });
const NOW = new Date('2026-09-13T12:00:00.000Z');

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seedLinked(db: ReturnType<typeof fresh>, bid: number, rating: number | null): number {
  return seedBeer(db, {
    untappd_id: bid, name: `Beer ${bid}`, brewery: 'Browar Test', style: 'IPA', abv: 6.2,
    rating_global: rating, normalized_name: `beer ${bid}`, normalized_brewery: 'browar test',
  });
}

function hydrated(bid: number, rating: number | null): HydratedBeer {
  return {
    bid, beer_name: `Beer ${bid}`, brewery_name: 'Browar Test', style: 'IPA', abv: 6.2,
    global_rating: rating, beer_slug: null, brewery_alias: [],
  };
}

function spyBreaker(canAttempt = true) {
  const results: boolean[] = [];
  const breaker: CircuitBreaker = {
    canAttempt: () => canAttempt,
    onResult: (blocked) => { results.push(blocked); },
    state: canAttempt ? 'closed' : 'open',
  };
  return { breaker, results };
}

describe('hydrateRatings (#616)', () => {
  test('writes hydrated ratings, backs off unknown bids and reports a closed breaker', async () => {
    const db = fresh();
    const known = seedLinked(db, 6648348, null);
    const unknown = seedLinked(db, 999999999, 3.9);
    const calls: number[][] = [];
    const { breaker, results } = spyBreaker();
    const res = await hydrateRatings({
      db, log: silentLog, breaker, now: () => NOW,
      hydrateByBid: async (bids) => { calls.push(bids); return new Map([[6648348, hydrated(6648348, 4.06)]]); },
    });
    expect(calls).toHaveLength(1);
    expect([...calls[0]].sort()).toEqual([6648348, 999999999]);
    expect(res).toEqual({ candidates: 2, updated: 1, changed: 1, unknown: 1, blocked: false, failed: false });
    expect(results).toEqual([false]);
    expect(getBeer(db, known)).toMatchObject({ rating_global: 4.06, rating_checked_at: NOW.toISOString() });
    expect(getBeer(db, unknown)).toMatchObject({ rating_global: 3.9, rating_checked_at: null, rating_refresh_count: 1 });
  });

  test('a block trips the breaker and writes nothing', async () => {
    const db = fresh();
    const id = seedLinked(db, 101, 3.5);
    const { breaker, results } = spyBreaker();
    const res = await hydrateRatings({
      db, log: silentLog, breaker, now: () => NOW,
      hydrateByBid: async () => { throw new HttpError(403, 'https://x-dsn.algolia.net/1/indexes/*/objects'); },
    });
    expect(res.blocked).toBe(true);
    expect(results).toEqual([true]);
    expect(getBeer(db, id)).toMatchObject({ rating_global: 3.5, rating_checked_at: null, rating_refresh_at: null, rating_refresh_count: 0 });
  });

  test('a transient failure writes nothing and does not touch the breaker', async () => {
    const db = fresh();
    const id = seedLinked(db, 102, 3.5);
    const { breaker, results } = spyBreaker();
    const res = await hydrateRatings({
      db, log: silentLog, breaker, now: () => NOW,
      hydrateByBid: async () => { throw new Error('socket hang up'); },
    });
    expect(res).toMatchObject({ failed: true, blocked: false, updated: 0 });
    expect(results).toEqual([]);
    expect(getBeer(db, id)).toMatchObject({ rating_global: 3.5, rating_checked_at: null, rating_refresh_count: 0 });
  });

  test('disabled lookup, an open breaker and an empty queue never call Algolia', async () => {
    let called = 0;
    const hydrateByBid = async () => { called++; return new Map<number, HydratedBeer>(); };

    const withRow = fresh();
    seedLinked(withRow, 103, null);
    await hydrateRatings({ db: withRow, log: silentLog, hydrateByBid, lookupEnabled: false, now: () => NOW });
    await hydrateRatings({ db: withRow, log: silentLog, hydrateByBid, breaker: spyBreaker(false).breaker, now: () => NOW });

    const empty = fresh();
    const { breaker, results } = spyBreaker();
    await hydrateRatings({ db: empty, log: silentLog, hydrateByBid, breaker, now: () => NOW });

    expect(called).toBe(0);
    expect(results).toEqual([]);
  });

  test('one request carries at most RATING_HYDRATION_BATCH bids, even with a larger limit', async () => {
    const db = fresh();
    for (let i = 0; i < RATING_HYDRATION_BATCH + 1; i++) seedLinked(db, 10_000 + i, null);
    const sizes: number[] = [];
    await hydrateRatings({
      db, log: silentLog, now: () => NOW, limit: 5000,
      hydrateByBid: async (bids) => { sizes.push(bids.length); return new Map(); },
    });
    expect(sizes).toEqual([RATING_HYDRATION_BATCH]);
  });

  test('passes the limit through when it is below the batch', async () => {
    const db = fresh();
    for (let i = 0; i < 3; i++) seedLinked(db, 20_000 + i, null);
    const sizes: number[] = [];
    await hydrateRatings({
      db, log: silentLog, now: () => NOW, limit: 2,
      hydrateByBid: async (bids) => { sizes.push(bids.length); return new Map(); },
    });
    expect(sizes).toEqual([2]);
  });
});
