import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer } from './beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import { recordEnrichFailure, clearEnrichFailure, type EnrichFailureRow } from './enrich_failures';

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
  outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: '2026-06-11T00:00:00Z', ...over,
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
});
