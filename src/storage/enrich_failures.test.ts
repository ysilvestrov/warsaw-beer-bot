import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer } from './beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import { recordEnrichFailure, clearEnrichFailure, setEnrichFailureReview, type EnrichFailureRow } from './enrich_failures';

function freshDbWithBeer() {
  const db = openDb(':memory:');
  migrate(db);
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Taking Shape', brewery: 'Track', style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Taking Shape'), normalized_brewery: normalizeBrewery('Track'),
  });
  return { db, id };
}

const row = (over: Partial<EnrichFailureRow> & { beer_id: number }): EnrichFailureRow => ({
  brewery: 'Track', name: 'Taking Shape', search_url: 'https://untappd.com/search?q=Track+Taking+Shape&type=beer',
  source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: '2026-06-11T00:00:00Z', ...over,
});

describe('enrich_failures', () => {
  test('record inserts a row', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got).toMatchObject({ beer_id: id, outcome: 'not_found', candidates_count: 0, fail_count: 1 });
  });

  test('record upserts: bumps fail_count and refreshes fields', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, at: '2026-06-11T00:00:00Z' }));
    recordEnrichFailure(db, row({ beer_id: id, outcome: 'blocked', candidates_count: 0, at: '2026-06-11T01:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.fail_count).toBe(2);
    expect(got.outcome).toBe('blocked');
    expect(got.last_at).toBe('2026-06-11T01:00:00Z');
  });

  test('clear deletes the row', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    clearEnrichFailure(db, id);
    expect(db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id)).toBeUndefined();
  });

  test('deleting the beer cascades to enrich_failures', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    db.prepare('DELETE FROM beers WHERE id = ?').run(id);
    expect(db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id)).toBeUndefined();
  });

  test('record stores source_url', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, source_url: 'https://beerfreak.org/p/x' }));
    const got = db.prepare('SELECT source_url FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.source_url).toBe('https://beerfreak.org/p/x');
  });

  test('upsert does not overwrite a known source_url with an empty one', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, source_url: 'https://beerfreak.org/p/x' }));
    recordEnrichFailure(db, row({ beer_id: id, source_url: '' })); // cron re-fail, no URL
    const got = db.prepare('SELECT source_url FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.source_url).toBe('https://beerfreak.org/p/x');
  });

  test('upsert overwrites with a newer non-empty source_url (most-recent page wins)', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, source_url: 'https://beerfreak.org/p/old' }));
    recordEnrichFailure(db, row({ beer_id: id, source_url: 'https://beerfreak.org/p/new' }));
    const got = db.prepare('SELECT source_url FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.source_url).toBe('https://beerfreak.org/p/new');
  });

  test('setEnrichFailureReview updates review fields and reports change', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    const ok = setEnrichFailureReview(db, id, 'parser_bug', 'name split wrong', '2026-06-11T02:00:00Z');
    expect(ok).toBe(true);
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got).toMatchObject({ review_class: 'parser_bug', review_note: 'name split wrong', reviewed_at: '2026-06-11T02:00:00Z' });
  });

  test('setEnrichFailureReview reports no change for an unknown beer', () => {
    const { db } = freshDbWithBeer();
    expect(setEnrichFailureReview(db, 99999, 'wontfix', null, '2026-06-11T02:00:00Z')).toBe(false);
  });

  test('a recurring failure clears a prior review', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    setEnrichFailureReview(db, id, 'matcher_bug', null, '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, at: '2026-06-11T03:00:00Z' })); // fails again
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBeNull();
    expect(got.review_note).toBeNull();
    expect(got.reviewed_at).toBeNull();
    expect(got.fail_count).toBe(2);
  });
});
