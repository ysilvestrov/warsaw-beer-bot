import { vi } from 'vitest';
import { createCatalogCache, prepareCatalogChunked, type CatalogCache } from './catalog-cache';
import type { CatalogBeerWithRating } from './match-list';
import type { DB } from '../storage/db';

const rows: CatalogBeerWithRating[] = [
  { id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7, untappd_id: 111 },
  { id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta', abv: 5.0, rating_global: 3.5, untappd_id: null },
];

// A deferred promise so tests can control when a rebuild's prepare resolves.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Minimal cache under test with injected seams. `db` is never touched (load is injected).
function make(opts: Parameters<typeof createCatalogCache>[1]): CatalogCache {
  return createCatalogCache({} as DB, opts);
}

describe('createCatalogCache', () => {
  it('cold get builds once and returns the prepared catalog + byId', async () => {
    const load = vi.fn(() => rows);
    const cache = make({ getVersion: () => 0, load });
    const { prepared, byId } = await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    expect(prepared.beers.length).toBe(2);
    expect(byId.get(1)?.name).toBe('Atak Chmielu');
  });

  it('warm get reuses the cache — no second load while version is unchanged', async () => {
    const load = vi.fn(() => rows);
    const cache = make({ getVersion: () => 0, load });
    await cache.get();
    await cache.get();
    await cache.idle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves stale then rebuilds in the background after a version bump (SWR)', async () => {
    let version = 0;
    const load = vi.fn(() => rows);
    const cache = make({ getVersion: () => version, load });
    await cache.get();               // cold build at version 0
    version = 1;                     // catalog changed
    await cache.get();               // returns stale immediately, triggers bg rebuild
    await cache.idle();              // wait for the background rebuild
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent cold gets — prepare runs once', async () => {
    const d = deferred<void>();
    const prepare = vi.fn(async (r: CatalogBeerWithRating[]) => {
      await d.promise;
      return (await prepareCatalogChunked(r));
    });
    const cache = make({ getVersion: () => 0, load: () => rows, prepare });
    const a = cache.get();
    const b = cache.get();
    d.resolve();
    await Promise.all([a, b]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the TTL expires even if the version is unchanged', async () => {
    let clock = 1000;
    const load = vi.fn(() => rows);
    const cache = make({ getVersion: () => 0, load, now: () => clock, ttlMs: 5000 });
    await cache.get();               // built at t=1000
    clock = 7000;                    // > ttl later
    await cache.get();               // stale by TTL → triggers rebuild
    await cache.idle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a version bump during a rebuild leaves the result stale so the next get re-triggers', async () => {
    let version = 0;
    const load = vi.fn(() => rows);
    const prepare = vi.fn(async (r: CatalogBeerWithRating[]) => {
      version = 5;
      return prepareCatalogChunked(r);
    });
    const cache = make({ getVersion: () => version, load, prepare });
    await cache.get();               // cold build; captured version was 0, bumped to 5 mid-build
    await cache.get();               // 0 !== 5 → stale → bg rebuild
    await cache.idle();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('prepareCatalogChunked', () => {
  it('yields once per 2000-row chunk', async () => {
    const big: CatalogBeerWithRating[] = Array.from({ length: 2001 }, (_, i) => ({
      id: i + 1, brewery: `Brew ${i}`, name: `Beer ${i}`, abv: null, rating_global: null, untappd_id: null,
    }));
    const yieldSpy = vi.fn(() => Promise.resolve());
    const prepared = await prepareCatalogChunked(big, yieldSpy);
    expect(prepared.beers.length).toBe(2001);
    expect(yieldSpy.mock.calls.length).toBe(2); // ceil(2001/2000)
  });
});
