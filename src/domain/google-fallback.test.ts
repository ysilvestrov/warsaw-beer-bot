// src/domain/google-fallback.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import { gateGoogleCandidate, runGoogleFallback } from './google-fallback';
import type { ResolvedBeer, WebResolver } from '../sources/google/resolver';
import type { BeerSearch } from '../sources/untappd/search';
import pino from 'pino';

const log = pino({ level: 'silent' });
const noHydrate: BeerSearch = { search: async () => [] };

describe('gateGoogleCandidate (refined B1)', () => {
  const input = { brewery: 'Maryensztadt', name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon', abv: 11.5 };

  it('accepts same-language name-gate hit regardless of abv', () => {
    const cand: ResolvedBeer = { bid: 1000186, beer_name: 'Pan IPAni', brewery_name: 'Trzech Kumpli', abv: null };
    expect(gateGoogleCandidate({ brewery: 'Trzech Kumpli', name: 'PanIPAni', abv: null }, cand)).toBe(true);
  });

  it('accepts cross-language candidate on token overlap + abv corroboration', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 11.5,
    };
    expect(gateGoogleCandidate(input, cand)).toBe(true);
  });

  it('rejects same-brewery wrong-name beer (Artezan case) even if abv coincides', () => {
    const cand: ResolvedBeer = { bid: 2552312, beer_name: 'Te Czasy Się Skończyły', brewery_name: 'Browar Artezan', abv: 11.5 };
    expect(gateGoogleCandidate({ brewery: 'Artezan', name: 'Święty Spokój', abv: 11.5 }, cand)).toBe(false);
  });

  it('rejects a different brewery outright', () => {
    const cand: ResolvedBeer = { bid: 1, beer_name: 'Grimbergen Blanche', brewery_name: 'Brouwerij Alken-Maes', abv: 6 };
    expect(gateGoogleCandidate({ brewery: 'Carlsberg', name: 'Grimbergen blanche', abv: 6 }, cand)).toBe(false);
  });

  it('rejects token-overlap candidate when abv is out of tolerance', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 6.0,
    };
    expect(gateGoogleCandidate({ ...input, abv: 11.5 }, cand)).toBe(false);
  });

  it('rejects token-overlap candidate when input abv is missing', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 11.5,
    };
    expect(gateGoogleCandidate({ ...input, abv: null }, cand)).toBe(false);
  });
});

function seed(db: ReturnType<typeof openDb>, brewery: string, name: string) {
  return upsertBeer(db, { name, brewery, normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase() });
}
function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('runGoogleFallback', () => {
  const cross: ResolvedBeer = {
    bid: 5158585,
    beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
    brewery_name: 'Maryensztadt',
    abv: 11.5,
  };
  const input = { brewery: 'Maryensztadt', name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon', abv: 11.5 };

  it('returns a matched SearchResult, spends quota, and stamps web_tried_at', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runGoogleFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr?.bid).toBe(5158585);
    expect((db.prepare('SELECT count FROM web_search_quota').get() as { count: number }).count).toBe(1);
    expect(db.prepare('SELECT web_tried_at FROM beers WHERE id = ?').get(beerId)).toBeTruthy();
    db.close();
  });

  it('skips (no quota spent) when web_tried_at is within cooldown', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    db.prepare('UPDATE beers SET web_tried_at = ? WHERE id = ?').run('2026-07-20T12:00:00.000Z', beerId);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z'); // 4 days later < 30d cooldown

    const sr = await runGoogleFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr).toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS c FROM web_search_quota').get()).toMatchObject({ c: 0 });
    db.close();
  });

  it('returns null without calling the resolver when the day is at cap', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    db.prepare('INSERT INTO web_search_quota(day, count) VALUES (?, ?)').run('2026-07-24', 90);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runGoogleFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr).toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
    db.close();
  });

  it('hydrates abv from Algolia when the CSE candidate abv is null', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const noAbv: ResolvedBeer = { ...cross, abv: null };
    const resolver: WebResolver = { resolve: vi.fn(async () => [noAbv]) };
    const hydrate: BeerSearch = {
      search: vi.fn(async () => [
        { bid: 5158585, beer_name: noAbv.beer_name, brewery_name: 'Maryensztadt', style: null, abv: 11.5, global_rating: null },
      ]),
    };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runGoogleFallback({ db, resolver, hydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr?.bid).toBe(5158585);
    expect(hydrate.search).toHaveBeenCalled();
    db.close();
  });
});

import { lookupWithFallback } from './google-fallback';
import type { LookupOutcome } from './untappd-lookup';

describe('lookupWithFallback', () => {
  const matched: LookupOutcome = {
    kind: 'matched',
    result: { bid: 1, beer_name: 'A', brewery_name: 'B', style: null, abv: null, global_rating: null },
  };
  const notFoundEmpty: LookupOutcome = { kind: 'not_found', searchUrls: ['u'], candidates: [] };
  const notFoundWithCands: LookupOutcome = {
    kind: 'not_found',
    searchUrls: ['u'],
    candidates: [{ bid: 9, beer_name: 'X', brewery_name: 'Y', style: null, abv: null, global_rating: null }],
  };

  it('passes through a matched outcome without invoking the fallback', async () => {
    const fb = vi.fn();
    const out = await lookupWithFallback(async () => matched, 1, fb);
    expect(out).toBe(matched);
    expect(fb).not.toHaveBeenCalled();
  });

  it('does NOT invoke the fallback when candidates were non-empty (matcher rejection)', async () => {
    const fb = vi.fn();
    const out = await lookupWithFallback(async () => notFoundWithCands, 1, fb);
    expect(out).toBe(notFoundWithCands);
    expect(fb).not.toHaveBeenCalled();
  });

  it('invokes the fallback on not_found + empty candidates and upgrades to matched', async () => {
    const sr = { bid: 5158585, beer_name: 'A', brewery_name: 'B', style: null, abv: 11.5, global_rating: null };
    const fb = vi.fn(async () => sr);
    const out = await lookupWithFallback(async () => notFoundEmpty, 42, fb);
    expect(out).toEqual({ kind: 'matched', result: sr });
    expect(fb).toHaveBeenCalledWith(42);
  });

  it('keeps the original not_found when the fallback yields null', async () => {
    const fb = vi.fn(async () => null);
    const out = await lookupWithFallback(async () => notFoundEmpty, 42, fb);
    expect(out).toBe(notFoundEmpty);
  });

  it('is a no-op passthrough when fallback is null (feature-flag off)', async () => {
    const out = await lookupWithFallback(async () => notFoundEmpty, 42, null);
    expect(out).toBe(notFoundEmpty);
  });
});
