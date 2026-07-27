import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { normalizeName, normalizeBrewery } from './normalize';
import { applyLookupOutcome } from './lookup-outcome';
import type { LookupOutcome } from './untappd-lookup';
import type { SearchResult } from '../sources/untappd/search';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Taking Shape', brewery: 'Track', style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Taking Shape'), normalized_brewery: normalizeBrewery('Track'),
  });
  return { db, id, log: pino({ level: 'silent' }) };
}
const input = { brewery: 'Track', name: 'Taking Shape' };
const cand = (over: Partial<SearchResult>): SearchResult => ({
  bid: 1, beer_name: 'Some Beer', brewery_name: 'Some Brewery', style: null, abv: null, global_rating: null, ...over,
});
const failRow = (db: any, id: number) =>
  db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id);

describe('applyLookupOutcome failure logging', () => {
  test('not_found records a failure row with candidate summary', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = {
      kind: 'not_found',
      searchUrls: ['https://untappd.com/search?q=Track+Taking+Shape&type=beer'],
      candidates: [cand({ brewery_name: 'Track Brewing', beer_name: 'Taking Shape XPA' })],
    };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
    const row = failRow(db, id);
    expect(row).toMatchObject({ outcome: 'not_found', candidates_count: 1, fail_count: 1 });
    expect(row.candidates_summary).toContain('Track Brewing — Taking Shape XPA');
    expect(row.search_url).toContain('Track+Taking+Shape');
  });

  test('blocked records a failure row with zero candidates', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'blocked', searchUrl: 'https://untappd.com/search?q=Track&type=beer' };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toMatchObject({ outcome: 'blocked', candidates_count: 0 });
  });

  test('matched clears any prior failure row', () => {
    const { db, id, log } = fresh();
    applyLookupOutcome({ db, log }, id,
      { kind: 'not_found', searchUrls: ['u'], candidates: [] }, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toBeDefined();
    applyLookupOutcome({ db, log }, id,
      { kind: 'matched', result: cand({ bid: 999 }) }, '2026-06-11T01:00:00Z', input);
    expect(failRow(db, id)).toBeUndefined();
    expect(getBeer(db, id)?.untappd_id).toBe(999);
  });

  test('transient does not record a failure', () => {
    const { db, id, log } = fresh();
    applyLookupOutcome({ db, log }, id,
      { kind: 'transient', error: new Error('x') }, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toBeUndefined();
  });

  test('not_found persists the supplied sourceUrl', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'not_found', searchUrls: ['u'], candidates: [] };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z',
      { ...input, sourceUrl: 'https://beerfreak.org/p/x' });
    expect(failRow(db, id).source_url).toBe('https://beerfreak.org/p/x');
  });

  test('blocked persists the supplied sourceUrl', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'blocked', searchUrl: 'u' };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z',
      { ...input, sourceUrl: 'https://beerfreak.org/p/x' });
    expect(failRow(db, id).source_url).toBe('https://beerfreak.org/p/x');
  });

  test('omitting sourceUrl stores empty string', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'blocked', searchUrl: 'u' };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id).source_url).toBe('');
  });
});

describe('applyLookupOutcome merge', () => {
  test("returns 'merged' and redirects match_links when the bid already belongs to another row", () => {
    const { db, id, log } = fresh();
    const canonicalId = upsertBeer(db, {
      untappd_id: 777, name: 'Canonical Beer', brewery: 'Canonical Brewery',
      style: null, abv: null, rating_global: 4.2,
      normalized_name: normalizeName('Canonical Beer'),
      normalized_brewery: normalizeBrewery('Canonical Brewery'),
    });
    db.prepare(
      "INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user) VALUES ('ref-1', ?, 0.9, 0)",
    ).run(id);

    const kind = applyLookupOutcome(
      { db, log }, id,
      { kind: 'matched', result: cand({ bid: 777 }) },
      '2026-07-27T00:00:00Z', input,
    );

    expect(kind).toBe('merged');
    expect(getBeer(db, id)).toBeNull();              // orphan row deleted
    expect(getBeer(db, canonicalId)!.untappd_id).toBe(777);
    const link = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?').get('ref-1') as
      { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(canonicalId);  // match_links redirected to the canonical row
    db.close();
  });
});
