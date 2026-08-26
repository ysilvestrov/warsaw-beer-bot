import { openDb } from './db';
import { migrate, V23_BACKFILL_SQL } from './schema';
import { upsertBeer } from './beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import {
  recordEnrichFailure,
  clearEnrichFailure,
  setEnrichFailureReview,
  listUntriagedFailures,
  retireEnrichFailure,
  isWebFallbackBlocked,
  countRowsForIssue,
  listOwnerlessRows,
  countOwnerlessRows,
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

// Same fresh-migrated db as testDb(); named to match the chokepoint guard tests below
// (Task 2 brief), which seed rows at arbitrary beer_ids rather than via freshDbWithBeer's
// single autoincrement id.
const freshDb = testDb;

// Seeds a beer row AND its enrich_failures row directly (bypassing recordEnrichFailure's
// upsert) so a test can pin an arbitrary beer_id and control `outcome` independently of
// candidates_count — needed to exercise setEnrichFailureReview's guards, which key off
// outcome, not candidates_count.
function seedFailure(
  db: ReturnType<typeof openDb>,
  beerId: number,
  over: { outcome?: 'not_found' | 'blocked' } = {},
): void {
  db.prepare(
    'INSERT INTO beers (id, brewery, name, normalized_name, normalized_brewery) VALUES (?, ?, ?, ?, ?)',
  ).run(beerId, `brewery-${beerId}`, `name-${beerId}`, `name-${beerId}`, `brewery-${beerId}`);
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id, brewery, name, search_url, source_url, outcome, candidates_count, candidates_summary, fail_count, last_at)
     VALUES (?, 'b', 'n', '', '', ?, 0, '', 1, '2026-08-01T00:00:00.000Z')`,
  ).run(beerId, over.outcome ?? 'not_found');
}

const NOW = '2026-08-15T00:00:00.000Z';

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
    // #425: outcome no longer moves on an existing row for a blocked attempt — it learned
    // nothing, so the prior real observation (not_found) stands. See the dedicated
    // 'blocked never downgrades' tests below for the full set of guarantees.
    expect(got.outcome).toBe('not_found');
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
    const result = setEnrichFailureReview(db, id, 'parser_bug', 'name split wrong', '2026-06-11T02:00:00Z');
    expect(result).toBe('written');
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got).toMatchObject({ review_class: 'parser_bug', review_note: 'name split wrong', reviewed_at: '2026-06-11T02:00:00Z' });
  });

  test('setEnrichFailureReview reports no change for an unknown beer', () => {
    const { db } = freshDbWithBeer();
    expect(setEnrichFailureReview(db, 99999, 'matcher_bug', null, '2026-06-11T02:00:00Z')).toBe('no_row');
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
    // absenceProved: true — this test is about re-fail behaviour, not the guard, so it
    // supplies the evidence the guard requires rather than exercising the refusal path.
    setEnrichFailureReview(db, id, 'not_on_untappd', null, '2026-06-11T02:00:00Z', null, { absenceProved: true });
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
    setEnrichFailureReview(db, id, 'not_on_untappd', null, '2026-06-11T02:00:00Z', null, { absenceProved: true });
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
    setEnrichFailureReview(db, id, 'not_on_untappd', null, '2026-06-11T04:00:00Z', null, { absenceProved: true });
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
    setEnrichFailureReview(db, 4, 'matcher_bug', null, '2026-07-02T01:00:00Z'); // reviewed → excluded

    const rows = listUntriagedFailures(db, 10);
    expect(rows.map((r) => r.beer_id)).toEqual([2, 1]); // newest first
    expect(listUntriagedFailures(db, 1).map((r) => r.beer_id)).toEqual([2]); // cap
    expect(rows[0]).toMatchObject({
      brewery: 'B', name: 'b', search_url: 'u2', candidates_count: 2,
      candidates_summary: 'x|y', fail_count: 1, last_at: '2026-07-03T00:00:00Z',
    });
  });

  // The triage prompt compares the shop's ABV against a candidate's before calling
  // them the same beer, so the batch must carry it (2026-07-28 evidence pipeline).
  test('listUntriagedFailures exposes the beer abv and style', () => {
    const db = testDb();
    const id = upsertBeer(db, {
      untappd_id: null, name: 'Hazy American Pale Ale', brewery: 'ReCraft Brewery',
      style: 'Hazy APA', abv: 4.2, rating_global: null,
      normalized_name: normalizeName('Hazy American Pale Ale'),
      normalized_brewery: normalizeBrewery('ReCraft Brewery'),
    });
    recordEnrichFailure(db, row({ beer_id: id, brewery: 'ReCraft Brewery', name: 'Hazy American Pale Ale' }));

    const [got] = listUntriagedFailures(db, 10);
    expect(got.abv).toBe(4.2);
    expect(got.style).toBe('Hazy APA');
  });
});

describe('retireEnrichFailure', () => {
  test('sets retired_at, appends note, preserves review_class', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    setEnrichFailureReview(db, id, 'parser_bug', 'garbled name', '2026-07-01T00:00:00Z');
    const changed = retireEnrichFailure(db, id, 'retired: current non-beer filter rejects', '2026-07-19T00:00:00Z');
    expect(changed).toBe(true);
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.retired_at).toBe('2026-07-19T00:00:00Z');
    expect(got.review_class).toBe('parser_bug');
    expect(got.review_note).toContain('garbled name');
    expect(got.review_note).toContain('retired: current non-beer filter rejects');
  });
  test('is idempotent — a second call does not change or re-append', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    retireEnrichFailure(db, id, 'retired: x', '2026-07-19T00:00:00Z');
    const changed = retireEnrichFailure(db, id, 'retired: x', '2026-07-20T00:00:00Z');
    expect(changed).toBe(false);
    const got = db.prepare('SELECT retired_at, review_note FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.retired_at).toBe('2026-07-19T00:00:00Z');
    expect((got.review_note.match(/retired: x/g) ?? []).length).toBe(1);
  });
  test('returns false when no row exists', () => {
    const { db } = freshDbWithBeer();
    expect(retireEnrichFailure(db, 999, 'retired: x', '2026-07-19T00:00:00Z')).toBe(false);
  });
  test('note stands alone (no leading separator) when there was no prior note', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id })); // review_note is NULL here
    retireEnrichFailure(db, id, 'retired: current non-beer filter rejects', '2026-07-19T00:00:00Z');
    const got = db.prepare('SELECT review_note FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_note).toBe('retired: current non-beer filter rejects');
  });
});

describe('isWebFallbackBlocked', () => {
  test('is false when there is no failure row at all', () => {
    const { db, id } = freshDbWithBeer();
    expect(isWebFallbackBlocked(db, id)).toBe(false);
    db.close();
  });

  test('is false for an untriaged failure', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    expect(isWebFallbackBlocked(db, id)).toBe(false);
    db.close();
  });

  test('is false for matcher_bug — the class the web fallback exists for', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-07-27T00:00:00.000Z');
    expect(isWebFallbackBlocked(db, id)).toBe(false);
    db.close();
  });

  // `unidentifiable` is blocked here even though it is NOT a pool exclusion: the free
  // Algolia retry keeps running for it, only the paid path stays shut (#349). Dropping
  // it from the IN list turns this red.
  test.each(['not_a_beer', 'unidentifiable', 'parser_bug', 'not_on_untappd'] as const)(
    'is true for %s',
    (cls) => {
      const { db, id } = freshDbWithBeer();
      recordEnrichFailure(db, row({ beer_id: id }));
      // absenceProved supplied only for not_on_untappd: this test's business is
      // isWebFallbackBlocked's SQL clause, not the chokepoint guard, so the fixture
      // proves absence rather than exercising the refusal path.
      setEnrichFailureReview(db, id, cls, 'note', '2026-07-27T00:00:00.000Z', null,
        { absenceProved: cls === 'not_on_untappd' });
      expect(isWebFallbackBlocked(db, id)).toBe(true);
      db.close();
    },
  );

  test('is true for a retired row regardless of class', () => {
    const { db, id } = freshDbWithBeer();
    recordEnrichFailure(db, row({ beer_id: id }));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-07-27T00:00:00.000Z');
    retireEnrichFailure(db, id, 'retired: fix shipped', '2026-07-27T00:00:00.000Z');
    expect(isWebFallbackBlocked(db, id)).toBe(true);
    db.close();
  });

  // #408: before v23 the row -> issue link was a free-text suffix nothing could query.
  test('setEnrichFailureReview records the issue number in its own column', () => {
    const db = testDb();
    const id = insertBeer(db, 1);
    recordEnrichFailure(db, row({ beer_id: id }));
    setEnrichFailureReview(db, id, 'matcher_bug', 'note', '2026-08-14T00:00:00.000Z', 408);
    const got = db.prepare('SELECT issue_number FROM enrich_failures WHERE beer_id = ?')
      .get(id) as { issue_number: number | null };
    expect(got.issue_number).toBe(408);
    db.close();
  });

  test('countRowsForIssue counts only rows reviewed after the given instant', () => {
    const db = testDb();
    const a = insertBeer(db, 1);
    const b = insertBeer(db, 2);
    recordEnrichFailure(db, row({ beer_id: a }));
    recordEnrichFailure(db, row({ beer_id: b }));
    setEnrichFailureReview(db, a, 'matcher_bug', 'a', '2026-08-01T00:00:00.000Z', 408);
    setEnrichFailureReview(db, b, 'matcher_bug', 'b', '2026-08-10T00:00:00.000Z', 408);
    expect(countRowsForIssue(db, 408, '2026-08-05T00:00:00.000Z')).toBe(1);
    expect(countRowsForIssue(db, 408, '2026-07-01T00:00:00.000Z')).toBe(2);
    db.close();
  });

  test('the v23 backfill recovers issue numbers from the legacy note suffix', () => {
    const db = testDb();
    const id = insertBeer(db, 1);
    recordEnrichFailure(db, row({ beer_id: id }));
    db.prepare("UPDATE enrich_failures SET review_note = 'alias gap → #347', issue_number = NULL WHERE beer_id = ?")
      .run(id);
    db.exec(V23_BACKFILL_SQL);          // the exact statement the migration runs
    const got = db.prepare('SELECT issue_number FROM enrich_failures WHERE beer_id = ?')
      .get(id) as { issue_number: number | null };
    expect(got.issue_number).toBe(347);
    db.close();
  });

  // The re-routing notes written on 2026-08-14 broke the clean suffix; CAST stops at the
  // first non-digit, so they still resolve rather than being lost.
  test('the v23 backfill survives a mangled suffix and ignores notes without one', () => {
    const db = testDb();
    const a = insertBeer(db, 1);
    const b = insertBeer(db, 2);
    recordEnrichFailure(db, row({ beer_id: a }));
    recordEnrichFailure(db, row({ beer_id: b }));
    db.prepare("UPDATE enrich_failures SET review_note = 'x → #405 (re-routed 2026-08-14 from #347)', issue_number = NULL WHERE beer_id = ?")
      .run(a);
    db.prepare("UPDATE enrich_failures SET review_note = 'plain note', issue_number = NULL WHERE beer_id = ?")
      .run(b);
    db.exec(V23_BACKFILL_SQL);
    const got = (id: number) => (db.prepare('SELECT issue_number FROM enrich_failures WHERE beer_id = ?')
      .get(id) as { issue_number: number | null }).issue_number;
    expect(got(a)).toBe(405);
    expect(got(b)).toBeNull();
    db.close();
  });
});

describe('recordEnrichFailure: blocked never downgrades', () => {
  // THE REPORTED CRASH. Red if the blocked guard is removed: this throws
  // SqliteError: CHECK constraint failed: review_class IS NULL OR outcome = 'not_found'
  // because the 0<->>0 clause does not fire (both counts are 0), so the verdict survives
  // the upsert onto outcome='blocked'.
  test('a blocked record on a triaged zero-candidate row preserves the verdict', () => {
    const db = freshDb();
    seedFailure(db, 1);
    expect(setEnrichFailureReview(db, 1, 'matcher_bug', 'alias gap', NOW, 347)).toBe('written');

    expect(() => recordEnrichFailure(db, {
      beer_id: 1, brewery: 'b', name: 'n', search_url: '', source_url: '',
      outcome: 'blocked', candidates_count: 0, candidates_summary: '',
      at: '2026-08-15T10:00:00.000Z',
    })).not.toThrow();

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 1').get() as any;
    expect(row.outcome).toBe('not_found');
    expect(row.review_class).toBe('matcher_bug');
    expect(row.reviewed_at).toBe(NOW);
    expect(row.fail_count).toBe(2);
    expect(row.last_at).toBe('2026-08-15T10:00:00.000Z');
  });

  // THE NEGATIVE CONTROL, and the reason #377's suite missed the bug: with candidates_count
  // > 0 the old code also survived — but only because the 0<->>0 clause nulled the verdict
  // first, i.e. it passed for the wrong reason. After the fix the verdict must SURVIVE.
  // Red if the guard keys off candidates_count instead of outcome.
  test('a blocked record on a triaged row with candidates preserves the verdict too', () => {
    const db = freshDb();
    seedFailure(db, 2);
    db.prepare('UPDATE enrich_failures SET candidates_count = 3, candidates_summary = ? WHERE beer_id = 2')
      .run('Mad Elf; MadTree; Mad Tom');
    expect(setEnrichFailureReview(db, 2, 'matcher_bug', 'alias gap', NOW, 347)).toBe('written');

    recordEnrichFailure(db, {
      beer_id: 2, brewery: 'b', name: 'n', search_url: '', source_url: '',
      outcome: 'blocked', candidates_count: 0, candidates_summary: '',
      at: '2026-08-15T10:00:00.000Z',
    });

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 2').get() as any;
    expect(row.review_class).toBe('matcher_bug');
    expect(row.candidates_count).toBe(3);
    expect(row.candidates_summary).toBe('Mad Elf; MadTree; Mad Tom');
  });

  // Red if the narrow UPDATE widens to touch diagnostics: a blocked attempt learned nothing,
  // so the last real evidence must stay readable for triage.
  test('a blocked record leaves search_url and the diagnostics of the last real attempt', () => {
    const db = freshDb();
    seedFailure(db, 3);
    db.prepare('UPDATE enrich_failures SET search_url = ? WHERE beer_id = 3')
      .run('https://untappd.com/search?q=real');

    recordEnrichFailure(db, {
      beer_id: 3, brewery: 'b', name: 'n', search_url: 'https://untappd.com/search?q=blocked',
      source_url: '', outcome: 'blocked', candidates_count: 0, candidates_summary: '',
      at: '2026-08-15T10:00:00.000Z',
    });

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 3').get() as any;
    expect(row.search_url).toBe('https://untappd.com/search?q=real');
  });

  // Red if the guard swallows creates as well as updates: a beer we have never recorded still
  // needs its blocked row (#377 relies on such rows existing and carrying no class).
  test('a blocked record still creates a row for a beer with no prior failure', () => {
    const db = freshDb();
    db.prepare(
      'INSERT INTO beers (id, brewery, name, normalized_name, normalized_brewery) VALUES (4, ?, ?, ?, ?)',
    ).run('b', 'n', 'n', 'b');

    recordEnrichFailure(db, {
      beer_id: 4, brewery: 'b', name: 'n', search_url: '', source_url: '',
      outcome: 'blocked', candidates_count: 0, candidates_summary: '',
      at: '2026-08-15T10:00:00.000Z',
    });

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 4').get() as any;
    expect(row.outcome).toBe('blocked');
    expect(row.review_class).toBeNull();
    expect(row.fail_count).toBe(1);
  });

  // Red if `outcome` is allowed to move on an existing row. A block window is about us, not
  // about the beer, and listUntriagedFailures excludes blocked — so letting it move silently
  // drops untriaged rows out of the triage queue.
  test('a block window does not push an untriaged row out of the triage queue', () => {
    const db = freshDb();
    seedFailure(db, 5);

    recordEnrichFailure(db, {
      beer_id: 5, brewery: 'b', name: 'n', search_url: '', source_url: '',
      outcome: 'blocked', candidates_count: 0, candidates_summary: '',
      at: '2026-08-15T10:00:00.000Z',
    });

    expect(listUntriagedFailures(db, 10).map((r) => r.beer_id)).toContain(5);
  });

  // Red if the guard is applied to an already-blocked row in some other way: two blocked
  // attempts in a row are just a counter bump, and the row keeps outcome='blocked'.
  //
  // The incoming brewery/name/search_url deliberately differ from what seedFailure(6, ...)
  // stored in enrich_failures (literal 'b'/'n'/''). Without the guard, the fall-through
  // INSERT...ON CONFLICT would overwrite all three from `excluded` — outcome/fail_count
  // alone stay byte-identical whether the guard exists or not, so they can't distinguish
  // the two code paths.
  test('a blocked record on an already-blocked row bumps the counter and touches nothing else', () => {
    const db = freshDb();
    seedFailure(db, 6, { outcome: 'blocked' });

    recordEnrichFailure(db, {
      beer_id: 6, brewery: 'incoming-brewery', name: 'incoming-name',
      search_url: 'https://untappd.com/search?q=incoming', source_url: '',
      outcome: 'blocked', candidates_count: 0, candidates_summary: '',
      at: '2026-08-15T10:00:00.000Z',
    });

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 6').get() as any;
    expect(row.outcome).toBe('blocked');
    expect(row.fail_count).toBe(2);
    expect(row.brewery).toBe('b');
    expect(row.name).toBe('n');
    expect(row.search_url).toBe('');
  });
});

// #421 beat 2. The unlock is a BET that the shipped fix covers this row: beat 1 re-arms it
// and keeps the verdict, because we still believe the verdict — we are testing it. This is
// where the bet settles. A retry that fails again is the evidence the verdict outlived its
// own fix, and only that evidence retires it.
describe('recordEnrichFailure: an unlocked row settles its verdict', () => {
  function unlock(db: ReturnType<typeof freshDb>, beerId: number): void {
    db.prepare('UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?')
      .run('2026-08-15T06:00:00.000Z', beerId);
  }

  function failAgain(db: ReturnType<typeof freshDb>, beerId: number, candidates = 3): void {
    recordEnrichFailure(db, {
      beer_id: beerId, brewery: 'b', name: 'n', search_url: '', source_url: '',
      outcome: 'not_found', candidates_count: candidates, candidates_summary: '',
      at: '2026-08-16T10:00:00.000Z',
    });
  }

  // Red if the `unlocked_at IS NOT NULL` arm is dropped from the CASE: the verdict would
  // survive a retry that disproved it, and the row would sit classified and invisible to
  // triage forever — sealed again by the very mechanism meant to unseal it.
  it('clears the verdict when the post-unlock retry fails again', () => {
    const db = freshDb();
    seedFailure(db, 1);
    db.prepare('UPDATE enrich_failures SET candidates_count = 3 WHERE beer_id = 1').run();
    expect(setEnrichFailureReview(db, 1, 'matcher_bug', 'alias gap → #347', NOW, 347)).toBe('written');
    unlock(db, 1);

    failAgain(db, 1);

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 1').get() as any;
    expect(row.review_class).toBeNull();
    expect(row.review_note).toBeNull();
    expect(row.reviewed_at).toBeNull();
    expect(row.unlocked_at).toBeNull();
  });

  // Red if the arm keys off the class instead of unlocked_at. An ordinary re-fail on a
  // locked-but-not-yet-unlocked row must keep its verdict — wiping those wholesale would
  // silently empty the triage record for every actionable row in the corpus.
  it('keeps the verdict when a row that was never unlocked fails again', () => {
    const db = freshDb();
    seedFailure(db, 2);
    db.prepare('UPDATE enrich_failures SET candidates_count = 3 WHERE beer_id = 2').run();
    setEnrichFailureReview(db, 2, 'matcher_bug', 'alias gap → #347', NOW, 347);

    failAgain(db, 2);

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 2').get() as any;
    expect(row.review_class).toBe('matcher_bug');
    expect(row.reviewed_at).toBe(NOW);
  });

  // Red if issue_number is cleared along with the class. The link is the evidence trail of
  // WHICH fix was tested and did not cover the row — the audit counter reads exactly that
  // residue, since beat 2 erases every other trace that the row was ever unlocked.
  it('leaves issue_number in place when beat 2 clears the verdict', () => {
    const db = freshDb();
    seedFailure(db, 3);
    db.prepare('UPDATE enrich_failures SET candidates_count = 3 WHERE beer_id = 3').run();
    setEnrichFailureReview(db, 3, 'parser_bug', 'split → #376', NOW, 376);
    unlock(db, 3);

    failAgain(db, 3);

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 3').get() as any;
    expect(row.review_class).toBeNull();
    expect(row.issue_number).toBe(376);
  });

  // Red if the 0<->>0 arm is replaced rather than joined by the new one (#377 part B).
  it('still clears the verdict when candidates_count crosses the 0<->>0 boundary', () => {
    const db = freshDb();
    seedFailure(db, 4);
    setEnrichFailureReview(db, 4, 'unidentifiable', 'no candidates', NOW);

    failAgain(db, 4, 4);

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 4').get() as any;
    expect(row.review_class).toBeNull();
  });

  // Red if beat 2 is moved ABOVE the blocked guard (#425), or if that guard is removed.
  // A blocked record never reaches the upsert, so an Untappd outage cannot settle a bet it
  // never tested: the free retry is still owed and the row keeps both its verdict and its
  // unlocked_at. This is the interaction between the two changes, and it only works in one
  // order.
  it('does not settle the bet on a blocked record — the free retry is still owed', () => {
    const db = freshDb();
    seedFailure(db, 5);
    db.prepare('UPDATE enrich_failures SET candidates_count = 3 WHERE beer_id = 5').run();
    setEnrichFailureReview(db, 5, 'matcher_bug', 'alias gap → #347', NOW, 347);
    unlock(db, 5);

    recordEnrichFailure(db, {
      beer_id: 5, brewery: 'b', name: 'n', search_url: '', source_url: '',
      outcome: 'blocked', candidates_count: 0, candidates_summary: '',
      at: '2026-08-16T10:00:00.000Z',
    });

    const row = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = 5').get() as any;
    expect(row.review_class).toBe('matcher_bug');
    expect(row.unlocked_at).toBe('2026-08-15T06:00:00.000Z');
  });
});

describe('setEnrichFailureReview guards', () => {
  it('refuses a verdict on a row we could not ask about', () => {
    const db = freshDb();                       // existing helper in this file
    seedFailure(db, 42, { outcome: 'blocked' }); // existing helper; add the option if missing
    expect(setEnrichFailureReview(db, 42, 'unidentifiable', 'n', NOW)).toBe('refused_unaskable');
    const row = db.prepare('SELECT review_class AS c FROM enrich_failures WHERE beer_id = 42')
      .get() as { c: string | null };
    expect(row.c).toBeNull();
  });

  it('refuses not_on_untappd unless absence was proved', () => {
    const db = freshDb();
    seedFailure(db, 43, { outcome: 'not_found' });
    expect(setEnrichFailureReview(db, 43, 'not_on_untappd', 'n', NOW))
      .toBe('refused_unproved_absence');
    expect(setEnrichFailureReview(db, 43, 'not_on_untappd', 'n', NOW, null, { absenceProved: true }))
      .toBe('written');
  });

  it('still writes an ordinary verdict and still reports a missing row', () => {
    const db = freshDb();
    seedFailure(db, 44, { outcome: 'not_found' });
    expect(setEnrichFailureReview(db, 44, 'not_a_beer', 'merch', NOW)).toBe('written');
    expect(setEnrichFailureReview(db, 45, 'matcher_bug', 'n', NOW)).toBe('no_row');
  });
});

describe('listOwnerlessRows / countOwnerlessRows', () => {
  it('returns only actionable classes with no issue and a machine-readable reason', () => {
    const d = testDb();
    const seed = (id: number, note: string | null, cls: string, issue: number | null) => {
      // recordEnrichFailure's FK requires the beer row to already exist.
      d.prepare(
        'INSERT INTO beers (id, brewery, name, normalized_name, normalized_brewery) VALUES (?, ?, ?, ?, ?)',
      ).run(id, `B${id}`, `N${id}`, `n${id}`, `b${id}`);
      recordEnrichFailure(d, {
        beer_id: id, brewery: `B${id}`, name: `N${id}`, search_url: 'u', source_url: '',
        outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: '2026-08-26T00:00:00Z',
      });
      d.prepare('UPDATE enrich_failures SET review_class=?, review_note=?, issue_number=? WHERE beer_id=?')
        .run(cls, note, issue, id);
    };
    seed(1, 'off-scope #300: candidates_count = 0', 'matcher_bug', null);   // in
    seed(2, 'no absence evidence: probably absent', 'matcher_bug', null);   // in
    seed(3, 'free prose from the model', 'matcher_bug', null);              // out — #508
    seed(4, 'off-scope #300: candidates_count = 0', 'matcher_bug', 300);    // out — has an owner
    seed(5, 'off-scope #300: candidates_count = 0', 'not_on_untappd', null);// out — not actionable

    expect(listOwnerlessRows(d).map((r) => r.beer_id)).toEqual([1, 2]);
    expect(countOwnerlessRows(d)).toBe(3);  // every actionable ownerless row, prose included
  });
});
