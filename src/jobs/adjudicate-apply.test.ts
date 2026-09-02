import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import {
  recordEnrichFailure, setEnrichFailureReview, retireEnrichFailure, markUnrescued,
} from '../storage/enrich_failures';
import { parseVerdictFile, applyVerdicts } from './adjudicate-apply';
import type { Verdict } from './adjudicate-issue-rows';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// An orphan whose triage verdict already names `issue` as its rescuing fix — the shape
// every row applyVerdicts is asked about has. Copied from adjudicate-issue-rows.test.ts
// per this repo's per-file fixture convention: a seed that writes through a guarded API
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

const fileFor = (verdicts: Verdict[]) => ({
  issue: 576, probed_at: '2026-09-02T10:00:00.000Z', verdicts,
});

describe('applyVerdicts', () => {
  it('marks only the unrescued verdicts', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    orphanWithIssue(db, 2, 576);
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued' },
      { beer_id: 2, brewery: 'Mad Brew', name: 'Row 2', verdict: 'rescued' },
    ]), '2026-09-02T11:00:00.000Z');
    expect(report).toEqual({ marked: 1, alreadyMarked: 0, skipped: [] });
    const one = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string; unrescued_issue: number };
    expect(one).toEqual({ unrescued_at: '2026-09-02T11:00:00.000Z', unrescued_issue: 576 });
    const two = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 2')
      .get() as { unrescued_at: string | null };
    expect(two.unrescued_at).toBeNull();
  });

  it('skips a row that matched since the probe, and still applies the rest', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    orphanWithIssue(db, 2, 576);
    db.prepare('UPDATE beers SET untappd_id = 999576 WHERE id = 1').run();
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued' },
      { beer_id: 2, brewery: 'Mad Brew', name: 'Row 2', verdict: 'unrescued' },
    ]), '2026-09-02T11:00:00.000Z');
    expect(report.marked).toBe(1);
    expect(report.skipped).toEqual([{ beer_id: 1, reason: 'not_orphan' }]);
  });

  it('skips a row re-triaged onto another issue — the marker must name the issue that proved it', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    db.prepare('UPDATE enrich_failures SET issue_number = 600 WHERE beer_id = 1').run();
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued' },
    ]), '2026-09-02T11:00:00.000Z');
    expect(report).toEqual({ marked: 0, alreadyMarked: 0, skipped: [{ beer_id: 1, reason: 'issue_moved' }] });
  });

  it('skips a row retired since the probe', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    expect(retireEnrichFailure(db, 1, 'resolved', '2026-09-02T10:30:00Z')).toBe(true);
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued' },
    ]), '2026-09-02T11:00:00.000Z');
    expect(report.skipped).toEqual([{ beer_id: 1, reason: 'retired' }]);
  });

  it('skips a row whose probed input no longer matches the stored row', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    db.prepare('UPDATE beers SET name = ? WHERE id = 1').run('a different split');
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued' },
    ]), '2026-09-02T11:00:00.000Z');
    expect(report.skipped).toEqual([{ beer_id: 1, reason: 'input_changed' }]);
  });

  it('reports a row that was already marked rather than counting it as new', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    markUnrescued(db, 1, 576, '2026-09-01T00:00:00Z');
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued' },
    ]), '2026-09-02T11:00:00.000Z');
    expect(report).toEqual({ marked: 0, alreadyMarked: 1, skipped: [] });
  });

  it('rejects a malformed file rather than applying part of it', () => {
    expect(() => parseVerdictFile({ issue: 576 })).toThrow();
    expect(() => parseVerdictFile({ issue: 576, probed_at: 'x', verdicts: [{ beer_id: 1 }] })).toThrow();
    expect(parseVerdictFile(fileFor([]))).toEqual(fileFor([]));
  });
});
