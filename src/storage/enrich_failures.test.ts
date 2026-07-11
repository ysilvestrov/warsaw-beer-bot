import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer } from './beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import {
  recordEnrichFailure,
  clearEnrichFailure,
  setEnrichFailureReview,
  listUntriagedFailures,
  type EnrichFailureRow,
} from './enrich_failures';

function freshDbWithBeer() {
  const db = openDb(':memory:');
  migrate(db);
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Taking Shape', brewery: 'Track', style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Taking Shape'), normalized_brewery: normalizeBrewery('Track'),
  });
  return { db, id };
}

function testDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// Inserts a beer with a distinct name/brewery so autoincrement assigns id `n`
// (fresh in-memory db, called in order n = 1, 2, 3, ...). Word-based labels:
// numeric suffixes are stripped as noise by normalization, which would collapse
// all beers into one upserted row.
const BEER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six'];
function insertBeer(db: ReturnType<typeof openDb>, n: number) {
  const name = `Beer ${BEER_WORDS[n - 1]}`;
  const brewery = `Craft ${BEER_WORDS[n - 1]}`;
  return upsertBeer(db, {
    untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
  });
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

  test('same-signal re-fail (0→0) PRESERVES a prior review (no churn)', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0 }));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0, at: '2026-06-11T03:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBe('matcher_bug');
    expect(got.review_note).toBe('note');
    expect(got.reviewed_at).toBe('2026-06-11T02:00:00Z');
    expect(got.fail_count).toBe(2);
    expect(got.last_at).toBe('2026-06-11T03:00:00Z');
  });

  test('same-signal re-fail (N→N) PRESERVES a prior review', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 2, candidates_summary: 'X — Y' }));
    setEnrichFailureReview(db, id, 'not_on_untappd', null, '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 5, candidates_summary: 'X — Y', at: '2026-06-11T03:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBe('not_on_untappd');
    expect(got.candidates_count).toBe(5);
  });

  test('boundary crossing 0→N re-opens triage (clears review)', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0 }));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 3, candidates_summary: 'X — Y', at: '2026-06-11T03:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBeNull();
    expect(got.review_note).toBeNull();
    expect(got.reviewed_at).toBeNull();
    expect(got.fail_count).toBe(2);
    expect(got.candidates_count).toBe(3);
  });

  test('boundary crossing N→0 re-opens triage (clears review)', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 2, candidates_summary: 'X — Y' }));
    setEnrichFailureReview(db, id, 'not_on_untappd', null, '2026-06-11T02:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0, candidates_summary: '', at: '2026-06-11T03:00:00Z' }));
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBeNull();
  });

  test('lifecycle: a boundary crossing re-opens, then a same-side re-fail re-sticks', () => {
    const { db, id } = freshDbWithBeer();
    // Classified while cand=0.
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 0 }));
    setEnrichFailureReview(db, id, 'matcher_bug', 'n1', '2026-06-11T02:00:00Z');
    // 0→N crossing re-opens for triage (cleared).
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 4, candidates_summary: 'X — Y', at: '2026-06-11T03:00:00Z' }));
    let got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBeNull();
    // Re-classified on the new (N) side, then a same-side N→N re-fail stays sticky.
    setEnrichFailureReview(db, id, 'not_on_untappd', null, '2026-06-11T04:00:00Z');
    recordEnrichFailure(db, row({ beer_id: id, candidates_count: 6, candidates_summary: 'X — Y', at: '2026-06-11T05:00:00Z' }));
    got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBe('not_on_untappd');
    expect(got.fail_count).toBe(3);
  });

  test('the review_class CHECK constraint rejects an invalid class', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    expect(() =>
      db.prepare('UPDATE enrich_failures SET review_class = ? WHERE beer_id = ?').run('bogus', id),
    ).toThrow();
  });

  test('listUntriagedFailures: newest-first, cap, excludes blocked and reviewed', () => {
    const db = testDb();
    insertBeer(db, 1); insertBeer(db, 2); insertBeer(db, 3); insertBeer(db, 4);
    recordEnrichFailure(db, { beer_id: 1, brewery: 'A', name: 'a', search_url: 'u1',
      source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '',
      at: '2026-07-01T00:00:00Z' });
    recordEnrichFailure(db, { beer_id: 2, brewery: 'B', name: 'b', search_url: 'u2',
      source_url: '', outcome: 'not_found', candidates_count: 2, candidates_summary: 'x|y',
      at: '2026-07-03T00:00:00Z' });
    recordEnrichFailure(db, { beer_id: 3, brewery: 'C', name: 'c', search_url: 'u3',
      source_url: '', outcome: 'blocked', candidates_count: 0, candidates_summary: '',
      at: '2026-07-04T00:00:00Z' }); // blocked → excluded
    recordEnrichFailure(db, { beer_id: 4, brewery: 'D', name: 'd', search_url: 'u4',
      source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '',
      at: '2026-07-02T00:00:00Z' });
    setEnrichFailureReview(db, 4, 'wontfix', null, '2026-07-02T01:00:00Z'); // reviewed → excluded

    const rows = listUntriagedFailures(db, 10);
    expect(rows.map((r) => r.beer_id)).toEqual([2, 1]); // newest first
    expect(listUntriagedFailures(db, 1).map((r) => r.beer_id)).toEqual([2]); // cap
    expect(rows[0]).toMatchObject({
      brewery: 'B', name: 'b', search_url: 'u2', candidates_count: 2,
      candidates_summary: 'x|y', fail_count: 1, last_at: '2026-07-03T00:00:00Z',
    });
  });
});
