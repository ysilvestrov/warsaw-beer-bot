// src/domain/web-fallback.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { seedBeer } from '../storage/seed-beer.testing';
import { evaluateCandidate, gateWebCandidate, runWebFallback } from './web-fallback';
import type { ResolvedBeer, WebResolver } from '../sources/websearch/resolver';
import type { BeerSearch, HydratedBeer } from '../sources/untappd/search';
import pino from 'pino';
import { recordEnrichFailure, setEnrichFailureReview } from '../storage/enrich_failures';

const log = pino({ level: 'silent' });
const noHydrate: BeerSearch = { search: async () => [] };

describe('gateWebCandidate (refined B1)', () => {
  const input = { brewery: 'Maryensztadt', name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon', abv: 11.5 };

  it('accepts same-language name-gate hit regardless of abv', () => {
    const cand: ResolvedBeer = { bid: 1000186, beer_name: 'Pan IPAni', brewery_name: 'Trzech Kumpli', abv: null };
    expect(gateWebCandidate({ brewery: 'Trzech Kumpli', name: 'PanIPAni', abv: null }, cand)).toBe(true);
  });

  it('accepts cross-language candidate on token overlap + abv corroboration', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 11.5,
    };
    expect(gateWebCandidate(input, cand)).toBe(true);
  });

  it('rejects same-brewery wrong-name beer (Artezan case) even if abv coincides', () => {
    const cand: ResolvedBeer = { bid: 2552312, beer_name: 'Te Czasy Się Skończyły', brewery_name: 'Browar Artezan', abv: 11.5 };
    expect(gateWebCandidate({ brewery: 'Artezan', name: 'Święty Spokój', abv: 11.5 }, cand)).toBe(false);
  });

  it('rejects a different brewery outright', () => {
    const cand: ResolvedBeer = { bid: 1, beer_name: 'Grimbergen Blanche', brewery_name: 'Brouwerij Alken-Maes', abv: 6 };
    expect(gateWebCandidate({ brewery: 'Carlsberg', name: 'Grimbergen blanche', abv: 6 }, cand)).toBe(false);
  });

  it('rejects token-overlap candidate when abv is out of tolerance', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 6.0,
    };
    expect(gateWebCandidate({ ...input, abv: 11.5 }, cand)).toBe(false);
  });

  it('rejects token-overlap candidate when input abv is missing', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: 11.5,
    };
    expect(gateWebCandidate({ ...input, abv: null }, cand)).toBe(false);
  });
});

describe('evaluateCandidate (stage-returning gate core)', () => {
  const input = { brewery: 'Maryensztadt', name: 'Ice Brett Porter Double BA Suszona Śliwka i Cynamon', abv: 11.5 };

  it('returns reject:brewery when the brewery gate fails', () => {
    const cand: ResolvedBeer = { bid: 1, beer_name: 'Grimbergen Blanche', brewery_name: 'Brouwerij Alken-Maes', abv: 6 };
    expect(evaluateCandidate({ brewery: 'Carlsberg', name: 'Grimbergen blanche', abv: 6 }, cand)).toBe('reject:brewery');
  });

  it('returns accept when the same-language name gate passes', () => {
    const cand: ResolvedBeer = { bid: 1000186, beer_name: 'Pan IPAni', brewery_name: 'Trzech Kumpli', abv: null };
    expect(evaluateCandidate({ brewery: 'Trzech Kumpli', name: 'PanIPAni', abv: null }, cand)).toBe('accept');
  });

  it('returns reject:name-token when brewery matches but nothing in the name does', () => {
    const cand: ResolvedBeer = { bid: 2552312, beer_name: 'Te Czasy Się Skończyły', brewery_name: 'Browar Artezan', abv: 11.5 };
    expect(evaluateCandidate({ brewery: 'Artezan', name: 'Święty Spokój', abv: 11.5 }, cand)).toBe('reject:name-token');
  });

  it('returns needs-abv for the cross-language token-overlap branch', () => {
    const cand: ResolvedBeer = {
      bid: 5158585,
      beer_name: 'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
      brewery_name: 'Maryensztadt',
      abv: null,
    };
    expect(evaluateCandidate(input, cand)).toBe('needs-abv');
  });

  // #636 (final review): the name gate reads digit-free names, and the web fallback runs exactly when Algolia found
  // nothing — the case of a number Untappd search cannot find.
  it('returns reject:digits for another number of the same series', () => {
    const cand: ResolvedBeer = { bid: 5899401, beer_name: 'Dr. Hazy #4', brewery_name: 'Piwne Podziemie', abv: null };
    expect(evaluateCandidate({ brewery: 'Piwne Podziemie', name: 'Dr.Hazy #7', abv: null }, cand)).toBe('reject:digits');
  });

  it('control: the same number still passes the name gate', () => {
    const cand: ResolvedBeer = { bid: 5899401, beer_name: 'Dr. Hazy #4', brewery_name: 'Piwne Podziemie', abv: null };
    expect(evaluateCandidate({ brewery: 'Piwne Podziemie', name: 'Dr.Hazy #4', abv: null }, cand)).toBe('accept');
  });

  it('a number only the Untappd name carries is accepted, as in lookupBeer (Few More Beer)', () => {
    const cand: ResolvedBeer = { bid: 6819481, beer_name: 'Few More Beer 004/108', brewery_name: 'TankBusters.Co', abv: 8.4 };
    expect(evaluateCandidate({ brewery: 'Tankbusters', name: 'Few More Beers', abv: 8.4 }, cand)).toBe('accept');
  });
});

function seed(db: ReturnType<typeof openDb>, brewery: string, name: string) {
  return seedBeer(db, { name, brewery, normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase() });
}
function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('runWebFallback', () => {
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

    const sr = await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr?.bid).toBe(5158585);
    expect((db.prepare('SELECT count FROM web_search_quota').get() as { count: number }).count).toBe(1);
    expect(db.prepare('SELECT web_tried_at FROM beers WHERE id = ?').get(beerId)).toEqual({
      web_tried_at: '2026-07-24T12:00:00.000Z',
    });
    db.close();
  });

  it('skips (no quota spent) when web_tried_at is within cooldown', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    db.prepare('UPDATE beers SET web_tried_at = ? WHERE id = ?').run('2026-07-20T12:00:00.000Z', beerId);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z'); // 4 days later < 30d cooldown

    const sr = await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
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

    const sr = await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr).toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
    db.close();
  });

  it('hydrates abv from Algolia when the resolver candidate abv is null', async () => {
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

    const sr = await runWebFallback({ db, resolver, hydrate, cap: 90, log, now }, { beerId, ...input });
    expect(sr?.bid).toBe(5158585);
    expect(hydrate.search).toHaveBeenCalled();
    db.close();
  });

  it('skips a parser_bug orphan without spending quota or stamping a cooldown', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    recordEnrichFailure(db, {
      beer_id: beerId, brewery: input.brewery, name: input.name,
      search_url: 'u', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-07-24T00:00:00.000Z',
    });
    setEnrichFailureReview(db, beerId, 'parser_bug', 'garbled', '2026-07-24T00:00:00.000Z');
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const { logger, debug } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log: logger, now }, { beerId, ...input });

    expect(sr).toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS c FROM web_search_quota').get()).toMatchObject({ c: 0 });
    // The stamp must stay NULL: a free skip must not cost the beer its 30-day
    // cooldown, or the retry after the parser fix ships waits a month.
    expect(
      (db.prepare('SELECT web_tried_at FROM beers WHERE id = ?').get(beerId) as { web_tried_at: string | null })
        .web_tried_at,
    ).toBeNull();
    expect(debug).toHaveBeenCalledWith({ beerId, reason: 'review-class' }, 'web-fallback skipped');
    db.close();
  });

  it('still runs for a matcher_bug orphan', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    recordEnrichFailure(db, {
      beer_id: beerId, brewery: input.brewery, name: input.name,
      search_url: 'u', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-07-24T00:00:00.000Z',
    });
    setEnrichFailureReview(db, beerId, 'matcher_bug', 'divergent name', '2026-07-24T00:00:00.000Z');
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log, now }, { beerId, ...input });

    expect(sr?.bid).toBe(5158585);
    expect(resolver.resolve).toHaveBeenCalled();
    db.close();
  });

  // A logger that records what runWebFallback reports, without pino formatting.
  function spyLog() {
    const info = vi.fn();
    const debug = vi.fn();
    return { logger: { ...pino({ level: 'silent' }), info, debug } as never, info, debug };
  }

  it('logs one info line with the rejection stage and both abv sides', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const noAbv: ResolvedBeer = { ...cross, abv: null };
    const resolver: WebResolver = { resolve: vi.fn(async () => [noAbv]) };
    const { logger, info } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    // input abv null → the needs-abv branch cannot corroborate → reject:abv
    const sr = await runWebFallback(
      { db, resolver, hydrate: noHydrate, cap: 90, log: logger, now },
      { beerId, brewery: input.brewery, name: input.name, abv: null },
    );

    expect(sr).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, msg] = info.mock.calls[0];
    expect(msg).toBe('web-fallback call');
    expect(fields).toMatchObject({ beerId, results: 1, verdict: 'rejected' });
    expect(fields.rejected[0]).toMatchObject({
      bid: 5158585, stage: 'reject:abv', inputAbv: null, candAbv: null,
    });
    db.close();
  });

  it('logs verdict matched with the winning bid', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const resolver: WebResolver = { resolve: vi.fn(async () => [cross]) };
    const { logger, info } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log: logger, now }, { beerId, ...input });

    expect(info.mock.calls[0][0]).toMatchObject({ verdict: 'matched', matchedBid: 5158585, results: 1 });
  });

  it('logs verdict no-candidates when the resolver returns nothing', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const resolver: WebResolver = { resolve: vi.fn(async () => []) };
    const { logger, info } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    await runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log: logger, now }, { beerId, ...input });

    expect(info.mock.calls[0][0]).toMatchObject({ verdict: 'no-candidates', results: 0, rejected: [] });
  });

  it('logs reject:brewery for the immediate push-and-continue branch, without hydrating abv', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const mismatch: ResolvedBeer = { bid: 1, beer_name: 'Grimbergen Blanche', brewery_name: 'Brouwerij Alken-Maes', abv: 6 };
    const resolver: WebResolver = { resolve: vi.fn(async () => [mismatch]) };
    const hydrate: BeerSearch = { search: vi.fn(async () => []) };
    const { logger, info } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    const sr = await runWebFallback({ db, resolver, hydrate, cap: 90, log: logger, now }, { beerId, ...input });

    expect(sr).toBeNull();
    expect(hydrate.search).not.toHaveBeenCalled();
    const fields = info.mock.calls[0][0];
    expect(fields).toMatchObject({ verdict: 'rejected', results: 1 });
    expect(fields.rejected[0]).toMatchObject({ stage: 'reject:brewery', candAbv: 6 });
  });

  it('logs the spend and rethrows unchanged when the resolver throws, still stamping web_tried_at', async () => {
    const db = freshDb();
    const beerId = seed(db, input.brewery, input.name);
    const boom = new Error('resolver exploded');
    const resolver: WebResolver = { resolve: vi.fn(async () => { throw boom; }) };
    const { logger, info } = spyLog();
    const now = () => new Date('2026-07-24T12:00:00Z');

    await expect(
      runWebFallback({ db, resolver, hydrate: noHydrate, cap: 90, log: logger, now }, { beerId, ...input }),
    ).rejects.toThrow(boom);

    expect((db.prepare('SELECT count FROM web_search_quota').get() as { count: number }).count).toBe(1);
    expect(db.prepare('SELECT web_tried_at FROM beers WHERE id = ?').get(beerId)).toEqual({
      web_tried_at: '2026-07-24T12:00:00.000Z',
    });
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, msg] = info.mock.calls[0];
    expect(msg).toBe('web-fallback call');
    expect(fields).toMatchObject({ beerId, results: 0, verdict: 'error', rejected: [] });
    db.close();
  });
});

import { lookupWithFallback } from './web-fallback';
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


describe('#665 input Czech style in web fallback', () => {
  const input = { brewery: 'KONRAD Brewery', name: 'Konrad 10°', abv: null, style: 'Czech Lager' };
  const candidate: ResolvedBeer = { bid: 158057, brewery_name: 'KONRAD Brewery', beer_name: 'Konrad 12°', abv: null };
  test('input-only style rejects different degrees and allows equal ones', () => {
    expect(evaluateCandidate(input, candidate)).toBe('reject:digits');
    expect(gateWebCandidate(input, candidate)).toBe(false);
    expect(gateWebCandidate({ ...input, name: 'Konrad 12°' }, candidate)).toBe(true);
  });
  test('the spent fallback never returns the wrong-grade result', async () => {
    const db = freshDb();
    try {
      const beerId = seed(db, input.brewery, input.name);
      expect(await runWebFallback({ db, log, cap: 90, hydrate: noHydrate,
        resolver: { resolve: async () => [candidate] } }, { beerId, ...input })).toBeNull();
    } finally { db.close(); }
  });
});


describe('#665 verified candidate style in web fallback', () => {
  const input = { brewery: 'KONRAD Brewery', name: 'Konrad 10°', abv: 4 };
  const twelve: ResolvedBeer = { bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery', abv: null };
  const record: HydratedBeer = { ...twelve, style: 'Czech Lager', abv: 5.2,
    global_rating: 3.5, beer_slug: 'konrad-12', brewery_alias: [] };

  async function probe(hydrate: BeerSearch, card: { brewery: string; name: string; abv: number | null; style?: string | null } = input, candidates = [twelve]) {
    const db = freshDb();
    try {
      const beerId = seed(db, card.brewery, card.name);
      const info = vi.fn();
      const sr = await runWebFallback({ db, hydrate, resolver: { resolve: async () => candidates },
        cap: 90, log: { ...log, info } as never,
        now: () => new Date('2026-09-28T13:00:00Z') }, { beerId, ...card });
      return { sr, rejected: info.mock.calls[0][0].rejected,
        quota: db.prepare('SELECT count FROM web_search_quota').get(),
        stamp: db.prepare('SELECT web_tried_at FROM beers WHERE id = ?').get(beerId) };
    } finally { db.close(); }
  }

  test('candidate-only Czech style rejects an exact-name wrong grade by exact bid', async () => {
    const byBid = vi.fn(async () => new Map([[158057, record]]));
    const search = vi.fn(async () => []);
    const out = await probe({ search, hydrateByBid: byBid });
    expect(out.sr).toBeNull();
    expect(byBid.mock.calls).toEqual([[[158057]]]);
    expect(search.mock.calls).toEqual([]);
    expect(out.rejected).toEqual([{ bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery',
      stage: 'reject:digits', inputAbv: 4, candAbv: 5.2 }]);
    expect(out.quota).toEqual({ count: 1 });
    expect(out.stamp).toEqual({ web_tried_at: '2026-09-28T13:00:00.000Z' });
  });

  test.each(['Wheat Beer - Hefeweizen', 'Pszeniczne', 'Lager - Pale'])(
    'verified %s keeps non-Czech conflicting grades soft', async (style) => {
      const byBid = vi.fn(async () => new Map([[158057, { ...record, style }]]));
      const out = await probe({ search: async () => [], hydrateByBid: byBid });
      expect(out.sr).toEqual({ bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery',
        style, abv: 5.2, global_rating: null });
      expect(out.rejected).toEqual([]);
      expect(byBid.mock.calls).toEqual([[[158057]]]);
    });

  test.each<[string, Map<number, HydratedBeer | null>]>([
    ['missing entry', new Map()],
    ['explicit missing record', new Map([[158057, null]])],
    ['null style', new Map([[158057, { ...record, style: null }]])],
    ['empty style', new Map([[158057, { ...record, style: '  ' }]])],
    ['wrong record bid', new Map([[158057, { ...record, bid: 999 }]])],
    ['wrong map key', new Map([[999, record]])],
  ])('unverified style (%s) cannot accept a conflicting grade', async (_label, records) => {
    const out = await probe({ search: async () => [], hydrateByBid: async () => records });
    expect(out.sr).toBeNull();
    expect(out.rejected).toEqual([{ bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery',
      stage: 'reject:style', inputAbv: 4, candAbv: null }]);
  });

  test('a hydration error leaves the conflict unresolved without throwing', async () => {
    const out = await probe({ search: async () => [], hydrateByBid: async () => { throw new Error('blocked'); } });
    expect(out.sr).toBeNull();
    expect(out.rejected).toEqual([{ bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery',
      stage: 'reject:style', inputAbv: 4, candAbv: null }]);
  });

  test('search-only hydration takes the exact bid rather than the first result', async () => {
    const search = vi.fn(async () => [{ ...record, bid: 999, style: 'Wheat' }, record]);
    const out = await probe({ search });
    expect(out.sr).toBeNull();
    expect(search.mock.calls).toEqual([['Konrad 12°']]);
    expect(out.rejected).toEqual([{ bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery',
      stage: 'reject:digits', inputAbv: 4, candAbv: 5.2 }]);
  });

  test('search-only results for another bid provide no style evidence', async () => {
    const out = await probe({ search: async () => [{ ...record, bid: 999, style: 'Wheat' }] });
    expect(out.sr).toBeNull();
    expect(out.rejected).toEqual([{ bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery',
      stage: 'reject:style', inputAbv: 4, candAbv: null }]);
  });

  test('rejection does not mask a remaining same-grade candidate', async () => {
    const ten = { ...twelve, bid: 45, beer_name: 'Konrad 10°' };
    const byBid = vi.fn(async () => new Map([[158057, record]]));
    const out = await probe({ search: async () => [], hydrateByBid: byBid }, input, [twelve, ten]);
    expect(out.sr).toEqual({ ...ten, style: null, global_rating: null });
    expect(byBid.mock.calls).toEqual([[[158057]]]);
  });

  test.each<[string, string]>([
    ['Konrad 12°', 'Konrad 12°'],
    ['Konrad 12°', 'Konrad 12.0°'],
    ['Konrad 10°', 'Konrad'],
    ['Konrad 10° 11°', 'Konrad 12°'],
    ['Konrad 10°', 'Konrad 11° 12°'],
    ['Konrad 14.5°', 'Konrad 12°'],
    ['Konrad 6°', 'Konrad 12°'],
    ['Konrad 12°', 'Konrad 21°'],
    ['Konrad IPA 10°', 'Konrad IPA 12°'],
  ])('no additional call without an eligible explicit conflict: %s / %s', async (name, candidateName) => {
    const byBid = vi.fn(async () => new Map());
    const search = vi.fn(async () => []);
    await probe({ search, hydrateByBid: byBid }, { ...input, name }, [{ ...twelve, beer_name: candidateName }]);
    expect(byBid.mock.calls).toEqual([]);
    expect(search.mock.calls).toEqual([]);
  });

  test.each(['Wheat', 'Pszeniczne', 'IPA'])('known input %s preserves acceptance without extra calls', async (style) => {
    const byBid = vi.fn(async () => new Map());
    const search = vi.fn(async () => []);
    const out = await probe({ search, hydrateByBid: byBid }, { ...input, style });
    expect(out.sr).toEqual({ ...twelve, style: null, global_rating: null });
    expect(byBid.mock.calls).toEqual([]);
    expect(search.mock.calls).toEqual([]);
  });

  test.each(['Konrad 7°', 'Konrad 20°', 'Konrad 10° 10.0°'])(
    'unique integer boundary/duplicate conflicts require verified style: %s', async (name) => {
      const byBid = vi.fn(async () => new Map([[158057, record]]));
      const out = await probe({ search: async () => [], hydrateByBid: byBid }, { ...input, name });
      expect(out.sr).toBeNull();
      expect(byBid.mock.calls).toEqual([[[158057]]]);
      expect(out.rejected).toEqual([{ bid: 158057, beer_name: 'Konrad 12°', brewery_name: 'KONRAD Brewery',
        stage: 'reject:digits', inputAbv: 4, candAbv: 5.2 }]);
    });

  test('an already rejected name causes no hydration', async () => {
    const byBid = vi.fn(async () => new Map());
    const search = vi.fn(async () => []);
    const out = await probe({ search, hydrateByBid: byBid }, input, [{ ...twelve, beer_name: 'Completely Different 12°' }]);
    expect(out.sr).toBeNull();
    expect(byBid.mock.calls).toEqual([]);
    expect(search.mock.calls).toEqual([]);
  });

  test('an already rejected brewery causes no hydration', async () => {
    const byBid = vi.fn(async () => new Map());
    const out = await probe({ search: async () => [], hydrateByBid: byBid }, input, [{ ...twelve, brewery_name: 'Pinta' }]);
    expect(out.sr).toBeNull();
    expect(byBid.mock.calls).toEqual([]);
  });

  const crossInput = { brewery: 'KONRAD Brewery', name: 'Jabłko Owocowe 10°', abv: 4 };
  const cross = { ...twelve, beer_name: 'Apple Owocowe 12°' };

  test('candidate-only Czech style also rejects the token-overlap branch', async () => {
    expect(evaluateCandidate(crossInput, cross)).toBe('needs-abv');
    const byBid = vi.fn(async () => new Map([[158057, { ...record, beer_name: cross.beer_name, abv: 4 }]]));
    const search = vi.fn(async () => []);
    const out = await probe({ search, hydrateByBid: byBid }, crossInput, [cross]);
    expect(out.sr).toBeNull();
    expect(byBid.mock.calls).toEqual([[[158057]]]);
    expect(search.mock.calls).toEqual([]);
  });

  test('the token-overlap branch reuses verified same-bid ABV', async () => {
    const byBid = vi.fn(async () => new Map([[158057, { ...record, style: 'Fruit Beer', abv: 4 }]]));
    const search = vi.fn(async () => []);
    const out = await probe({ search, hydrateByBid: byBid }, crossInput, [cross]);
    expect(out.sr).toEqual({ ...cross, style: 'Fruit Beer', abv: 4, global_rating: null });
    expect(byBid.mock.calls).toEqual([[[158057]]]);
    expect(search.mock.calls).toEqual([]);
  });

  test('missing verified ABV cannot corroborate token overlap or cause another lookup', async () => {
    const byBid = vi.fn(async () => new Map([[158057, { ...record, style: 'Fruit Beer', abv: null }]]));
    const search = vi.fn(async () => [{ ...record, style: 'Fruit Beer', abv: 4 }]);
    const out = await probe({ search, hydrateByBid: byBid }, crossInput, [cross]);
    expect(out.sr).toBeNull();
    expect(byBid.mock.calls).toEqual([[[158057]]]);
    expect(search.mock.calls).toEqual([]);
    expect(out.rejected).toEqual([{ bid: 158057, beer_name: 'Apple Owocowe 12°', brewery_name: 'KONRAD Brewery',
      stage: 'reject:abv', inputAbv: 4, candAbv: null }]);
  });
});
