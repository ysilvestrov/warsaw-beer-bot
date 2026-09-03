import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, rearmLookup, recordLookupNotFound } from '../storage/beers';
import {
  recordEnrichFailure, setEnrichFailureReview, retireEnrichFailure, markUnrescued,
} from '../storage/enrich_failures';
import {
  parseVerdictFile, applyVerdicts, isVerdictFileStale, verdictFileAgeMs, formatAge,
  summarizeVerdictFile, STALE_VERDICT_FILE_MS,
} from './adjudicate-apply';
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
  // #576 (рев'ю PR #580, P1): чотири перевірки рядка дивляться на brewery/name/untappd_id/
  // issue_number/retired_at — а `rearmLookup` не чіпає жодного з них. Ре-арм, що стався між
  // пробою і застосуванням, був невидимий, і застарілий вердикт тихо скасовував його грант.
  it('skips a row that was re-armed between the probe and the apply', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    // Рядок на момент проби: крон уже раз його шукав і не знайшов.
    recordLookupNotFound(db, 1, '2026-09-02T09:00:00.000Z');
    const probed = db.prepare(
      'SELECT untappd_lookup_at, untappd_lookup_count FROM beers WHERE id = 1',
    ).get() as { untappd_lookup_at: string; untappd_lookup_count: number };
    expect(probed.untappd_lookup_count).toBe(1);

    // ...а після проби оператор його явно ре-армив.
    rearmLookup(db, 1);

    const report = applyVerdicts(db, fileFor([{
      beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued',
      lookup_count: probed.untappd_lookup_count, lookup_at: probed.untappd_lookup_at, rearm_count: 0
    }]), '2026-09-02T11:00:00.000Z');

    expect(report).toEqual({ marked: 0, alreadyMarked: 0, skipped: [{ beer_id: 1, reason: 'lookup_moved' }] });
    const row = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string | null };
    expect(row.unrescued_at).toBeNull();
  });

  // #576 (рев'ю PR #580, друга P1): точний сценарій, де лукап-поля НЕ рухаються. Рядок уже
  // мав нулі на момент проби (щойно ре-армлений і ще не перепробуваний), тож наступний ре-арм
  // не змінює в них нічого — і без монотонного `rearm_count` був би невидимий.
  it('skips a re-arm that leaves the already-zero lookup state untouched', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    const atProbe = db.prepare(
      'SELECT untappd_lookup_at, untappd_lookup_count, rearm_count FROM beers WHERE id = 1',
    ).get() as { untappd_lookup_at: null; untappd_lookup_count: number; rearm_count: number };
    // Передумова сценарію: лукап-поля вже в нулях, тобто ре-арм їх не зрушить.
    expect(atProbe).toEqual({ untappd_lookup_at: null, untappd_lookup_count: 0, rearm_count: 0 });

    rearmLookup(db, 1);

    const after = db.prepare(
      'SELECT untappd_lookup_at, untappd_lookup_count, rearm_count FROM beers WHERE id = 1',
    ).get() as { untappd_lookup_at: null; untappd_lookup_count: number; rearm_count: number };
    // Ось чому лукап-полів не вистачало: вони після ре-арму буквально ті самі.
    expect(after.untappd_lookup_at).toBe(atProbe.untappd_lookup_at);
    expect(after.untappd_lookup_count).toBe(atProbe.untappd_lookup_count);
    expect(after.rearm_count).toBe(1);

    const report = applyVerdicts(db, fileFor([{
      beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued',
      lookup_count: atProbe.untappd_lookup_count, lookup_at: atProbe.untappd_lookup_at,
      rearm_count: atProbe.rearm_count,
    }]), '2026-09-02T11:00:00.000Z');

    expect(report).toEqual({ marked: 0, alreadyMarked: 0, skipped: [{ beer_id: 1, reason: 'lookup_moved' }] });
    const row = db.prepare('SELECT unrescued_at FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string | null };
    expect(row.unrescued_at).toBeNull();
  });

  // Той самий захист із іншого боку: не тільки явний ре-арм, а й звичайний крон, який устиг
  // зробити свій лукап після нашої проби. Наша проба перестала бути найсвіжішим свідченням.
  it('skips a row the enrich cron looked up after the probe', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    recordLookupNotFound(db, 1, '2026-09-02T10:30:00.000Z');

    const report = applyVerdicts(db, fileFor([{
      beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued',
      lookup_count: 0, lookup_at: null, rearm_count: 0
    }]), '2026-09-02T11:00:00.000Z');

    expect(report.marked).toBe(0);
    expect(report.skipped).toEqual([{ beer_id: 1, reason: 'lookup_moved' }]);
  });

  // Контроль: незрушений рядок і далі позначається — інакше перевірка вище блокувала б усе.
  it('still marks a row whose lookup state is exactly what was probed', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    recordLookupNotFound(db, 1, '2026-09-02T09:00:00.000Z');
    const probed = db.prepare(
      'SELECT untappd_lookup_at, untappd_lookup_count FROM beers WHERE id = 1',
    ).get() as { untappd_lookup_at: string; untappd_lookup_count: number };

    const report = applyVerdicts(db, fileFor([{
      beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued',
      lookup_count: probed.untappd_lookup_count, lookup_at: probed.untappd_lookup_at, rearm_count: 0
    }]), '2026-09-02T11:00:00.000Z');

    expect(report).toEqual({ marked: 1, alreadyMarked: 0, skipped: [] });
  });

  it('marks only the unrescued verdicts', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    orphanWithIssue(db, 2, 576);
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
      { beer_id: 2, brewery: 'Mad Brew', name: 'Row 2', verdict: 'rescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
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
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
      { beer_id: 2, brewery: 'Mad Brew', name: 'Row 2', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
    ]), '2026-09-02T11:00:00.000Z');
    expect(report.marked).toBe(1);
    expect(report.skipped).toEqual([{ beer_id: 1, reason: 'not_orphan' }]);
  });

  it('skips a row re-triaged onto another issue — the marker must name the issue that proved it', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    db.prepare('UPDATE enrich_failures SET issue_number = 600 WHERE beer_id = 1').run();
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
    ]), '2026-09-02T11:00:00.000Z');
    expect(report).toEqual({ marked: 0, alreadyMarked: 0, skipped: [{ beer_id: 1, reason: 'issue_moved' }] });
  });

  it('skips a row retired since the probe', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    expect(retireEnrichFailure(db, 1, 'resolved', '2026-09-02T10:30:00Z')).toBe(true);
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
    ]), '2026-09-02T11:00:00.000Z');
    expect(report.skipped).toEqual([{ beer_id: 1, reason: 'retired' }]);
  });

  it('skips a row whose probed input no longer matches the stored row', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    db.prepare('UPDATE beers SET name = ? WHERE id = 1').run('a different split');
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
    ]), '2026-09-02T11:00:00.000Z');
    expect(report.skipped).toEqual([{ beer_id: 1, reason: 'input_changed' }]);
  });

  it('reports a row that was already marked rather than counting it as new', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 576);
    markUnrescued(db, 1, 576, '2026-09-01T00:00:00Z');
    const report = applyVerdicts(db, fileFor([
      { beer_id: 1, brewery: 'Mad Brew', name: 'Row 1', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
    ]), '2026-09-02T11:00:00.000Z');
    expect(report).toEqual({ marked: 0, alreadyMarked: 1, skipped: [] });
  });

  it('rejects a malformed file rather than applying part of it', () => {
    expect(() => parseVerdictFile({ issue: 576 })).toThrow();
    expect(() => parseVerdictFile({ issue: 576, probed_at: 'x', verdicts: [{ beer_id: 1 }] })).toThrow();
    expect(parseVerdictFile(fileFor([]))).toEqual(fileFor([]));
  });

  // #576 minor finding: `missing` is the one SkipReason branch with no coverage — a verdict
  // naming a beer_id that has no row in `enrich_failures`/`beers` at all (e.g. the beer row was
  // deleted between probe and apply).
  it('skips a verdict naming a beer_id with no row at all', () => {
    const db = fresh();
    const report = applyVerdicts(db, fileFor([
      { beer_id: 999999, brewery: 'Nobody', name: 'Nothing', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
    ]), '2026-09-02T11:00:00.000Z');
    expect(report).toEqual({ marked: 0, alreadyMarked: 0, skipped: [{ beer_id: 999999, reason: 'missing' }] });
  });
});

describe('verdict-file staleness (#576 I3)', () => {
  const file = fileFor([{ beer_id: 1, brewery: 'x', name: 'y', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0}]);

  it('is not stale immediately after the probe', () => {
    expect(isVerdictFileStale(file, file.probed_at)).toBe(false);
  });

  it('is not stale just under the threshold', () => {
    const now = new Date(Date.parse(file.probed_at) + STALE_VERDICT_FILE_MS - 1000).toISOString();
    expect(isVerdictFileStale(file, now)).toBe(false);
  });

  it('is stale just over the threshold', () => {
    const now = new Date(Date.parse(file.probed_at) + STALE_VERDICT_FILE_MS + 1000).toISOString();
    expect(isVerdictFileStale(file, now)).toBe(true);
  });

  it('computes age in milliseconds', () => {
    const now = new Date(Date.parse(file.probed_at) + 90 * 60 * 1000).toISOString();
    expect(verdictFileAgeMs(file, now)).toBe(90 * 60 * 1000);
  });

  it('formats sub-hour ages in minutes and hour-plus ages in hours', () => {
    expect(formatAge(30 * 60 * 1000)).toBe('30m');
    expect(formatAge(90 * 60 * 1000)).toBe('1.5h');
  });

  it('summarizes issue, probed_at, age, and the verdict tally before any write', () => {
    const f = fileFor([
      { beer_id: 1, brewery: 'x', name: 'y', verdict: 'unrescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
      { beer_id: 2, brewery: 'x', name: 'z', verdict: 'rescued', lookup_count: 0, lookup_at: null , rearm_count: 0},
      { beer_id: 3, brewery: 'x', name: 'w', verdict: 'inconclusive', lookup_count: 0, lookup_at: null , rearm_count: 0},
      { beer_id: 4, brewery: 'x', name: 'v', verdict: 'already_marked', lookup_count: 0, lookup_at: null , rearm_count: 0},
    ]);
    const now = new Date(Date.parse(f.probed_at) + 30 * 60 * 1000).toISOString();
    expect(summarizeVerdictFile(f, now)).toBe(
      'issue 576, probed_at 2026-09-02T10:00:00.000Z (30m ago), '
      + '4 verdicts: 1 rescued / 1 unrescued / 1 inconclusive / 1 already marked',
    );
  });
});
