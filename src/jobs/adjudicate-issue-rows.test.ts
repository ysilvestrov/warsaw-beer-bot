import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { recordEnrichFailure, setEnrichFailureReview } from '../storage/enrich_failures';
import { adjudicateIssueRows } from './adjudicate-issue-rows';

const log = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// An orphan whose triage verdict already names `issue` as its rescuing fix — the shape
// every row adjudicateIssueRows is asked about has. Mirrors seedLocked
// (src/jobs/unlock-fixed-orphans.test.ts:36): a seed that writes through a guarded API
// must assert the write actually landed, or a silently no-op'd seed makes every
// assertion below true about nothing.
function orphanWithIssue(db: ReturnType<typeof fresh>, beerId: number, issue: number): void {
  const name = `Row ${beerId}`;
  const returnedId = upsertBeer(db, {
    untappd_id: null, name, brewery: 'Mad Brew', style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: 'mad brew',
  });
  recordEnrichFailure(db, {
    beer_id: returnedId, brewery: 'Mad Brew', name,
    search_url: '', source_url: '', outcome: 'not_found',
    candidates_count: 3, candidates_summary: '', at: '2026-08-01T00:00:00Z',
  });
  const written = setEnrichFailureReview(db, returnedId, 'matcher_bug', 'note', '2026-08-01T01:00:00Z', issue);
  expect(written).toBe('written');
}

describe('adjudicateIssueRows', () => {
  it('marks a row whose live probe still finds nothing', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 558);
    const out = await adjudicateIssueRows(
      { db, log, lookup: async () => ({ kind: 'not_found', searchUrls: ['u'], candidates: [] }),
        now: () => new Date('2026-09-02T10:00:00Z') },
      558,
    );
    expect(out).toMatchObject({ probed: 1, marked: 1, rescued: 0, inconclusive: 0 });
    const row = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string; unrescued_issue: number };
    expect(row.unrescued_at).toBe('2026-09-02T10:00:00.000Z');
    expect(row.unrescued_issue).toBe(558);
  });

  it('does NOT mark a row the probe now matches — it reports a rescue and leaves the row alone', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 558);
    const out = await adjudicateIssueRows(
      { db, log, lookup: async () => ({ kind: 'matched', result: { bid: 42, name: 'x', brewery: 'y' } as never }),
        now: () => new Date('2026-09-02T10:00:00Z') },
      558,
    );
    expect(out).toMatchObject({ probed: 1, marked: 0, rescued: 1 });
    const row = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string | null };
    expect(row.unrescued_at).toBeNull();
  });

  it('NEVER marks on a transient or blocked probe — a network failure is not a verdict', async () => {
    for (const outcome of [{ kind: 'transient', error: new Error('boom') },
                           { kind: 'blocked', searchUrl: 'u' }] as const) {
      const db = fresh();
      orphanWithIssue(db, 1, 558);
      const out = await adjudicateIssueRows(
        { db, log, lookup: async () => outcome as never, now: () => new Date('2026-09-02T10:00:00Z') },
        558,
      );
      expect(out).toMatchObject({ marked: 0, inconclusive: 1 });
      const row = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 1')
        .get() as { unrescued_at: string | null };
      expect(row.unrescued_at).toBeNull();
    }
  });

  it('touches no lookup counters — adjudication must not spend the row backoff', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 558);
    db.prepare('UPDATE beers SET untappd_lookup_count = 2, untappd_lookup_at = ? WHERE id = 1')
      .run('2026-08-01T00:00:00Z');
    await adjudicateIssueRows(
      { db, log, lookup: async () => ({ kind: 'not_found', searchUrls: ['u'], candidates: [] }),
        now: () => new Date('2026-09-02T10:00:00Z') },
      558,
    );
    const beer = getBeer(db, 1)!;
    expect(beer.untappd_lookup_count).toBe(2);
    expect(beer.untappd_lookup_at).toBe('2026-08-01T00:00:00Z');
  });
});
