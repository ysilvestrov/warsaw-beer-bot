import pino from 'pino';
import { vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { recordEnrichFailure, setEnrichFailureReview, retireEnrichFailure } from '../storage/enrich_failures';
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

  // #558 review finding #6: markUnrescued's idempotency guard (WHERE unrescued_at IS NULL)
  // means a re-probed, already-settled row returns `false` and used to land in NO bucket —
  // re-running an already-adjudicated issue printed `probed: 1, marked: 0`, indistinguishable
  // from "found nothing to mark". `alreadyMarked` makes that outcome legible instead.
  it('counts a re-probe of an already-marked row as alreadyMarked, not silence', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 558);
    const lookup = async () => ({ kind: 'not_found' as const, searchUrls: ['u'], candidates: [] });
    await adjudicateIssueRows({ db, log, lookup, now: () => new Date('2026-09-02T10:00:00Z') }, 558);

    const out = await adjudicateIssueRows(
      { db, log, lookup, now: () => new Date('2026-09-03T10:00:00Z') },
      558,
    );

    expect(out).toMatchObject({ probed: 1, marked: 0, alreadyMarked: 1, rescued: 0, inconclusive: 0 });
    // The original timestamp survives — a re-probe re-confirms, it does not re-date the verdict.
    const row = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string };
    expect(row.unrescued_at).toBe('2026-09-02T10:00:00.000Z');
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

  // Review finding #5 (2026-09-02): the row query's `ef.retired_at IS NULL` and
  // `b.untappd_id IS NULL` clauses had zero coverage — dropping either would silently make
  // the tool re-probe (and mark `unrescued`) a row a shipped fix already resolved, or a row
  // whose beer already carries a real Untappd bid. Neither has anything left to adjudicate.
  it('skips a retired row and a row whose beer already matched — neither gets probed', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 558);
    expect(retireEnrichFailure(db, 1, 'resolved by a shipped fix', '2026-08-05T00:00:00Z')).toBe(true);

    orphanWithIssue(db, 2, 558);
    db.prepare('UPDATE beers SET untappd_id = ? WHERE id = 2').run(999558);

    const lookup = vi.fn(async () => ({ kind: 'not_found' as const, searchUrls: ['u'], candidates: [] }));
    const out = await adjudicateIssueRows(
      { db, log, lookup, now: () => new Date('2026-09-02T10:00:00Z') },
      558,
    );

    expect(out).toMatchObject({ probed: 0, rescued: 0, marked: 0, inconclusive: 0 });
    expect(lookup).not.toHaveBeenCalled();
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
