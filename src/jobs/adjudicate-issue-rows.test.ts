import pino from 'pino';
import { vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer, recordLookupNotFound } from '../storage/beers';
import {
  recordEnrichFailure, setEnrichFailureReview, retireEnrichFailure, markUnrescued,
} from '../storage/enrich_failures';
import { getJobState, setJobState } from '../storage/job_state';
import { isCircuitOpen } from '../domain/untappd-circuit';
import { probeIssueRows } from './adjudicate-issue-rows';

const log = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// An orphan whose triage verdict already names `issue` as its rescuing fix — the shape
// every row probeIssueRows is asked about has. Mirrors seedLocked
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

const okCanary = async () => true;
const notFound = async () =>
  ({ kind: 'not_found' as const, searchUrls: ['u'], candidates: [] });

describe('probeIssueRows', () => {
  it('writes NOTHING to the database during a probe', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    db.prepare('UPDATE beers SET untappd_lookup_count = 2, untappd_lookup_at = ? WHERE id = 1')
      .run('2026-08-01T00:00:00Z');

    const out = await probeIssueRows(
      { db, log, lookup: notFound, canary: okCanary, now: () => new Date('2026-09-02T10:00:00Z') },
      576,
    );

    expect(out.status).toBe('ok');
    const row = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string | null; unrescued_issue: number | null };
    expect(row.unrescued_at).toBeNull();
    expect(row.unrescued_issue).toBeNull();
    const beer = getBeer(db, 1)!;
    expect(beer.untappd_lookup_count).toBe(2);
    expect(beer.untappd_lookup_at).toBe('2026-08-01T00:00:00Z');
  });

  // #576 I1: the runner wires its breaker as `{ canAttempt: (now) => !isCircuitOpen(...), ... }`
  // (never `createPersistentCircuitBreaker`, whose `canAttempt` deletes `job_state` on a
  // malformed or expired value — that was the bug review found live). This test drives
  // `probeIssueRows` through THAT exact composition with an EXPIRED open_until already
  // persisted, and demands `job_state` come back byte-identical — the assertion the original
  // "writes NOTHING" test above never made, because it only checked `enrich_failures`/`beers`.
  it('leaves an expired circuit-open marker in job_state untouched (production breaker wiring)', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    const KEY = 'untappd_circuit_open_until';
    setJobState(db, KEY, '2026-08-01T00:00:00.000Z'); // long expired relative to the probe's `now`

    const breaker = {
      canAttempt: (now: Date) => !isCircuitOpen(db, KEY, now),
      onResult: () => {},
      state: 'closed' as const,
    };
    const out = await probeIssueRows(
      { db, log, lookup: notFound, canary: okCanary, breaker, now: () => new Date('2026-09-02T10:00:00Z') },
      576,
    );

    expect(out.status).toBe('ok');
    expect(getJobState(db, KEY)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns a verdict per row, carrying the exact input it probed', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    // Ненульовий лукап-стан навмисно: якби проба писала у файл константу замість того, що
    // справді стоїть у рядку, з нулями це було б невідрізнити. #576 (рев'ю PR #580).
    recordLookupNotFound(db, 1, '2026-08-30T02:11:07.000Z');
    const out = await probeIssueRows(
      { db, log, lookup: notFound, canary: okCanary, now: () => new Date('2026-09-02T10:00:00Z') },
      576,
    );
    expect(out).toEqual({
      status: 'ok',
      file: {
        issue: 576,
        probed_at: '2026-09-02T10:00:00.000Z',
        verdicts: [{
          beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued',
          lookup_count: 1, lookup_at: '2026-08-30T02:11:07.000Z',
        }],
      },
    });
  });

  it('refuses to probe at all when the closing canary fails', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    let calls = 0;
    const canary = async () => { calls += 1; return calls === 1; };   // before ok, after fails
    const out = await probeIssueRows({ db, log, lookup: notFound, canary }, 576);
    expect(out).toEqual({ status: 'canary_failed', at: 'after' });
  });

  it('does not probe a single row when the opening canary fails', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    const lookup = vi.fn(notFound);
    const out = await probeIssueRows({ db, log, lookup, canary: async () => false }, 576);
    expect(out).toEqual({ status: 'canary_failed', at: 'before' });
    expect(lookup).not.toHaveBeenCalled();
  });

  // Finding 2 (review round on #576): a rotated key raises rather than returning 200+empty —
  // the exact case the canary exists to catch. A throw here must read as a failed canary, not
  // escape as an unhandled rejection that skips the "nothing written" outcome entirely.
  it('treats a throwing opening canary as a failed canary, not a crash', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    const lookup = vi.fn(notFound);
    const canary = async () => { throw new Error('auth error: key rotated'); };
    const out = await probeIssueRows({ db, log, lookup, canary }, 576);
    expect(out).toEqual({ status: 'canary_failed', at: 'before' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('treats a throwing closing canary as a failed canary, not a crash', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    let calls = 0;
    const canary = async () => {
      calls += 1;
      if (calls === 1) return true;         // before: ok
      throw new Error('auth error: key rotated');   // after: throws
    };
    const out = await probeIssueRows({ db, log, lookup: notFound, canary }, 576);
    expect(out).toEqual({ status: 'canary_failed', at: 'after' });
  });

  it('does not probe when the circuit is open, and does not touch the breaker', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    const lookup = vi.fn(notFound);
    const canary = vi.fn(okCanary);
    const out = await probeIssueRows(
      {
        db, log, lookup, canary,
        breaker: {
          canAttempt: () => false,
          onResult: () => { throw new Error('breaker must not be written'); },
          state: 'open' as const,
        },
      },
      576,
    );
    expect(out).toEqual({ status: 'circuit_open' });
    expect(lookup).not.toHaveBeenCalled();
    expect(canary).not.toHaveBeenCalled();
  });

  it('sleeps between probes and honours the limit', async () => {
    const db = fresh();
    for (const id of [1, 2, 3]) orphanWithIssue(db, id, 576);
    const slept: number[] = [];
    const out = await probeIssueRows(
      {
        db, log, lookup: notFound, canary: okCanary, limit: 2,
        sleep: async (ms) => { slept.push(ms); }, sleepMs: 500,
      },
      576,
    );
    expect(out.status).toBe('ok');
    expect(out.status === 'ok' && out.file.verdicts).toHaveLength(2);
    expect(slept).toEqual([500, 500]);       // one per probed row, none skipped
  });

  it('reports an already-marked row without probing it again', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    markUnrescued(db, 1, 576, '2026-09-01T00:00:00Z');
    const lookup = vi.fn(notFound);
    const out = await probeIssueRows({ db, log, lookup, canary: okCanary }, 576);
    expect(out.status === 'ok' && out.file.verdicts[0].verdict).toBe('already_marked');
    expect(lookup).not.toHaveBeenCalled();     // a settled row costs no quota
  });

  // #558 review finding #5, reasserted here: the row query's `ef.retired_at IS NULL` and
  // `b.untappd_id IS NULL` clauses had zero coverage before this test, and dropping either
  // would silently make the probe re-probe (and mark unrescued) a row a shipped fix already
  // resolved, or a row whose beer already carries a real Untappd bid — neither has anything
  // left to adjudicate.
  it('skips a retired row and a row whose beer already matched — neither is probed', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    expect(retireEnrichFailure(db, 1, 'resolved by a shipped fix', '2026-08-05T00:00:00Z')).toBe(true);

    orphanWithIssue(db, 2, 576);
    db.prepare('UPDATE beers SET untappd_id = ? WHERE id = 2').run(999576);

    const lookup = vi.fn(notFound);
    const out = await probeIssueRows({ db, log, lookup, canary: okCanary }, 576);

    expect(out.status === 'ok' && out.file.verdicts).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  // Finding 2 (review round on #576): every other test in this file drives `lookup` through
  // `notFound`, so a swap of the rescued/unrescued branches — or a dropped inconclusive
  // branch — would pass all of them. One test per remaining LookupOutcome kind closes that.
  it('maps a matched probe to rescued', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    const lookup = async () =>
      ({ kind: 'matched' as const, result: { bid: 42, name: 'x', brewery: 'y' } as never });
    const out = await probeIssueRows({ db, log, lookup, canary: okCanary }, 576);
    expect(out.status === 'ok' && out.file.verdicts[0].verdict).toBe('rescued');
  });

  it('maps a transient probe to inconclusive', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    const lookup = async () => ({ kind: 'transient' as const, error: new Error('boom') });
    const out = await probeIssueRows({ db, log, lookup, canary: okCanary }, 576);
    expect(out.status === 'ok' && out.file.verdicts[0].verdict).toBe('inconclusive');
  });

  it('maps a blocked probe to inconclusive', async () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    const lookup = async () => ({ kind: 'blocked' as const, searchUrl: 'u' });
    const out = await probeIssueRows({ db, log, lookup, canary: okCanary }, 576);
    expect(out.status === 'ok' && out.file.verdicts[0].verdict).toBe('inconclusive');
  });
});
