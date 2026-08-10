import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import { resolveByBid } from './bid-identity';
import type { HydratedBeer } from '../sources/untappd/search';

const BULGOGI: HydratedBeer = {
  bid: 6648348,
  beer_name: 'Tomatøl:BULDAK BULGOGI',
  brewery_name: 'Mad Brew',
  brewery_alias: ['mad brewlads', 'madbrew'],
  beer_slug: 'mad-brew-tomatol-buldak-bulgogi',
  style: 'Sour - Tomato / Vegetable Gose',
  abv: 4.2,
  global_rating: 4.06,
};

function freshDb() {
  const db = openDb(':memory:');   // same helper the other storage tests use
  migrate(db);
  return db;
}
const hydrateWith = (r: HydratedBeer | null) =>
  vi.fn(async (bids: number[]) => new Map(r ? [[r.bid, r]] : []));

describe('resolveByBid', () => {
  it('accepts a bid whose brewery agrees with the shop brand', async () => {
    const hydrate = hydrateWith(BULGOGI);
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348,
      bidSlug: 'mad-brew-tomatol-buldak-bulgogi', brand: 'Mad Brew', hydrate,
    });
    expect(out.kind).toBe('accepted');
    if (out.kind !== 'accepted') throw new Error('unreachable');
    expect(out.result.bid).toBe(6648348);
  });

  // The two negative assertions that matter most: both of these divergences are
  // REAL for this product, and vetoing on either would reject the feature's own
  // motivating case. Do not "fix" these into vetoes.
  it('does NOT veto when the shop name diverges from the record name', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'Mad Brew', shopName: 'Tomatol Bulgogi', hydrate: hydrateWith(BULGOGI),
    });
    expect(out.kind).toBe('accepted');
  });

  it('does NOT veto when the shop ABV diverges from the record ABV', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'Mad Brew', shopAbv: 3.8, hydrate: hydrateWith(BULGOGI),
    });
    expect(out.kind).toBe('accepted');
  });

  it('does NOT veto on slug divergence (logged only)', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'something-else', brand: 'Mad Brew',
      hydrate: hydrateWith(BULGOGI),
    });
    expect(out.kind).toBe('accepted');
  });

  it('vetoes when the brand names a different brewery', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'Browar Stu Mostów', hydrate: hydrateWith(BULGOGI),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'brewery-mismatch' });
  });

  it('accepts on a brewery ALIAS match', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      brand: 'MadBrew', hydrate: hydrateWith(BULGOGI),
    });
    expect(out.kind).toBe('accepted');
  });

  it('skips the guard when the shop publishes no brand', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi',
      hydrate: hydrateWith(BULGOGI),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'no-brand-to-verify' });
  });

  it('rejects when the bid hydrates to nothing', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 999999999, brand: 'Mad Brew', hydrate: hydrateWith(null),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'not-hydrated' });
  });

  it('rejects rather than throwing when hydration fails', async () => {
    const out = await resolveByBid({
      db: freshDb(), bid: 6648348, brand: 'Mad Brew',
      hydrate: vi.fn(async () => { throw new Error('blocked'); }),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'hydrate-failed' });
  });

  it('resolves from the local catalog without calling Algolia', async () => {
    const db = freshDb();
    upsertBeer(db, {
      untappd_id: 6648348, name: 'Tomatøl:BULDAK BULGOGI', brewery: 'Mad Brew',
      style: 'Gose', abv: 4.2, rating_global: 4.06,
      normalized_name: 'tomatol buldak bulgogi', normalized_brewery: 'mad brew',
    });
    const hydrate = vi.fn(async () => new Map());
    const out = await resolveByBid({
      db, bid: 6648348, bidSlug: 'mad-brew-tomatol-buldak-bulgogi', brand: 'Mad Brew', hydrate,
    });
    expect(out.kind).toBe('accepted');
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('still applies the brewery veto on the local path', async () => {
    const db = freshDb();
    upsertBeer(db, {
      untappd_id: 6648348, name: 'Tomatøl:BULDAK BULGOGI', brewery: 'Mad Brew',
      normalized_name: 'tomatol buldak bulgogi', normalized_brewery: 'mad brew',
    });
    const out = await resolveByBid({
      db, bid: 6648348, brand: 'Browar Stu Mostów', hydrate: vi.fn(async () => new Map()),
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'brewery-mismatch' });
  });
});
