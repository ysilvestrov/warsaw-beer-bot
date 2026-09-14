import { vi } from 'vitest';
import { createCatalogCache, prepareCatalogChunked, type CatalogCache } from './catalog-cache';
import type { CatalogBeerWithRating } from './match-list';
import type { DB } from '../storage/db';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { seedBeer } from '../storage/seed-beer.testing';
import { mergeIntoCanonical } from '../storage/beers';
import { normalizeBrewery, normalizeName } from './normalize';
import { matchBeerList } from './match-list';

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

// Minimal cache under test with injected seams. `db` is never touched (load and loadAliases are
// injected); a test may still override loadAliases through opts.
function make(opts: Parameters<typeof createCatalogCache>[1]): CatalogCache {
  return createCatalogCache({} as DB, { loadAliases: () => [], ...opts });
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

  it('routes a background rebuild failure to onError and keeps serving the stale value', async () => {
    let version = 0;
    const load = vi.fn(() => rows).mockImplementationOnce(() => rows);
    load.mockImplementationOnce(() => { throw new Error('load boom'); });
    const onError = vi.fn();
    const cache = make({ getVersion: () => version, load, onError });
    const first = await cache.get();  // cold build at version 0 (1st load succeeds)
    version = 1;                      // catalog changed
    const stale = await cache.get();  // returns stale, triggers bg rebuild (2nd load throws)
    await cache.idle();               // wait for the failed background rebuild
    expect(onError).toHaveBeenCalledTimes(1);
    expect(stale).toBe(first);        // still served the stale value, no throw
  });

  it('propagates a cold build failure to the caller without poisoning the cache', async () => {
    const load = vi.fn<() => CatalogBeerWithRating[]>(() => { throw new Error('cold boom'); });
    const cache = make({ getVersion: () => 0, load });
    await expect(cache.get()).rejects.toThrow('cold boom');
    // rebuilding was cleared → a subsequent get with a now-working load succeeds
    load.mockImplementation(() => rows);
    const { prepared } = await cache.get();
    expect(prepared.beers.length).toBe(2);
  });

  it('#614 builds the alias index from loadAliases and keeps aliases out of the matcher catalog', async () => {
    const aliasRows = [
      { beer_id: 1, name: 'Atak Chmielu IPA', normalized_brewery: 'pinta', normalized_name: 'atak chmielu ipa', name_digits: '' },
    ];
    const cache = make({ getVersion: () => 0, load: () => rows, loadAliases: () => aliasRows });
    const { prepared, byId, aliases } = await cache.get();
    expect(prepared.beers.map((b) => `${b.id} ${b.name}`)).toEqual(['1 Atak Chmielu', '2 Buty Skejta']);
    expect(byId.size).toBe(2);
    expect([...aliases.values()]).toEqual([{ beerId: 1, name: 'Atak Chmielu IPA' }]);
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

describe('#614 merge memory reaches /match', () => {
  it('after a merge the same shop card matches the canonical row exactly, with the drinker\'s status', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const canonicalId = seedBeer(db, {
      untappd_id: 3548624, name: 'Black Bean', brewery: 'Varvar Brew',
      style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    const orphanId = seedBeer(db, {
      name: 'BLACK BEAN IS', brewery: 'VARVAR', style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName('BLACK BEAN IS'), normalized_brewery: normalizeBrewery('VARVAR'),
    });
    mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T07:13:20Z');

    const card = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
    const drunk = new Set([canonicalId]);
    const ratings = new Map([[canonicalId, 4.5]]);
    const noYield = { yield: async () => {} };

    const { prepared, byId, aliases } = await createCatalogCache(db).get();

    // Контроль: без аліасів картка НЕ дає точного збігу — інакше тест нічого б не доводив
    // (прод-реплей 2026-09-14: null).
    const { results: [control] } = await matchBeerList(prepared, byId, drunk, ratings, [card], noYield);
    expect(control.source).not.toBe('exact');
    expect(control.is_drunk).toBe(false);

    const { results: [r] } = await matchBeerList(prepared, byId, drunk, ratings, [card], { ...noYield, aliases });
    expect(r.matched_beer).toEqual({
      id: canonicalId, name: 'Black Bean', brewery: 'Varvar Brew', rating_global: 4.14, untappd_id: 3548624,
    });
    expect(r.source).toBe('exact');
    expect(r.is_drunk).toBe(true);
    expect(r.user_rating).toBe(4.5);
  });
});
