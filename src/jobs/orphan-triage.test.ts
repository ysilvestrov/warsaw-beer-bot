import pino from 'pino';
import { expect, test, vi } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import { parseScopeBlock } from '../domain/triage-scope';
import { getJobState, setJobState } from '../storage/job_state';
import { recordEnrichFailure } from '../storage/enrich_failures';
import {
  orphanTriage, shouldRunTriage, buildTriageLine, reportGuardAnomalies,
  TRIAGE_LAST_RUN_KEY, TRIAGE_LAST_RESULT_KEY, TRIAGE_ATTEMPTS_KEY, TRIAGE_MAX_ATTEMPTS,
} from './orphan-triage';
import type { Analysis } from '../domain/triage-analysis';
import { HttpStatusError } from '../domain/transient-error';

const log = pino({ level: 'silent' });
// Warsaw 07:30 on 2026-07-05 (CEST = UTC+2) → 05:30Z
const inWindow = () => new Date('2026-07-05T05:30:00Z');

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

// Word-based names: numeric suffixes get stripped as noise by normalization,
// which would collapse all seeded beers into one upserted row.
const BEER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six'];
function insertBeer(d: ReturnType<typeof db>, n: number) {
  const name = `Beer ${BEER_WORDS[n - 1]}`;
  const brewery = `Craft ${BEER_WORDS[n - 1]}`;
  return upsertBeer(d, {
    untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
  });
}

// Insert a beers row + enrich failure.
function seedOrphan(d: ReturnType<typeof db>, beerId: number) {
  insertBeer(d, beerId);
  recordEnrichFailure(d, {
    beer_id: beerId, brewery: `Br${beerId}`, name: `Beer${beerId}`,
    search_url: 'u', source_url: '', outcome: 'not_found',
    candidates_count: 0, candidates_summary: '', at: `2026-07-0${beerId}T00:00:00Z`,
  });
}

// #408: an open issue whose body carries no `triage-scope` block is UNSCOPED and
// accepts no attachment, so the default stub has to render one or every routing test
// here would be asserting the guard rather than the routing it means to test. The
// cohort deliberately covers the small beer_ids these tests seed.
const SCOPED_BODY = 'b\n\n```triage-scope\n{"beer_ids":[1,2,3,4,5,6],"where":[]}\n```';

const gh = (over = {}) => ({
  // createdAt is required by OpenIssue and read by the saturation guard. A mock is not
  // type-checked, and a missing value does NOT throw — better-sqlite3 binds undefined,
  // the comparison goes NULL, and countRowsForIssue quietly returns 0, which would
  // disable the guard while every test still passed. So it is set deliberately.
  listOpenIssues: vi.fn().mockResolvedValue([
    { number: 228, title: 't', body: SCOPED_BODY, labels: [], createdAt: '2026-01-01T00:00:00.000Z' },
  ]),
  createIssue: vi.fn().mockResolvedValue(231),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  ...over,
});
const exchange = (analysis: Analysis, stopReason: string | null = 'tool_use') => ({
  analysis,
  raw: { prompt: 'p', response: {}, stopReason, provider: 'anthropic' as const },
});
const llm = (analysis: Analysis) => ({ analyze: vi.fn().mockResolvedValue(exchange(analysis)) });

test('shouldRunTriage: window and idempotency', () => {
  expect(shouldRunTriage({ now: inWindow(), lastRunDate: null }))
    .toEqual({ run: true, dateKey: '2026-07-05' });
  expect(shouldRunTriage({ now: inWindow(), lastRunDate: '2026-07-05' }).run).toBe(false);
  // 10:30 Warsaw = 08:30Z → outside [6,9)
  expect(shouldRunTriage({ now: new Date('2026-07-05T08:30:00Z'), lastRunDate: null }).run).toBe(false);
});

test('happy path: comment + new issue + quiet; DB and job_state written', async () => {
  const d = db();
  [1, 2, 3].forEach((n) => seedOrphan(d, n));
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 3, review_class: 'matcher_bug', review_note: 'alias', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'parser_bug', review_note: 'merch', issue_number: null, new_issue_key: 'k1' },
      { beer_id: 1, review_class: 'not_on_untappd', review_note: 'small batch', issue_number: null, new_issue_key: null },
    ],
    new_issues: [{
      key: 'k1', title: 'Adapter noise', body: 'b', labels: [], scope: { beer_ids: [1, 2, 3, 4, 5, 6], where: [] },
    }],
  };
  const github = gh();
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });

  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  expect(github.createIssue).toHaveBeenCalledWith(
    expect.objectContaining({ labels: ['orphan-triage', 'parser-bug'] }),
  );
  const rows = d.prepare(
    'SELECT beer_id, review_class, review_note FROM enrich_failures ORDER BY beer_id',
  ).all() as { beer_id: number; review_class: string; review_note: string }[];
  // #408 guard 3: this run has no `search` dep, so no probe ran, so beer 1's
  // not_on_untappd claim has NO absence evidence behind it and is degraded to
  // matcher_bug. That keeps the row in the enrichment pool (only not_a_beer/retired_at
  // are excluded there) instead of closing it on a guess — #377 measured 7 of 14
  // weakly-evidenced absence verdicts as flat wrong.
  expect(rows.map((r) => r.review_class)).toEqual(['matcher_bug', 'parser_bug', 'matcher_bug']);
  expect(rows[0].review_note).toBe('no absence evidence: small batch');
  expect(rows[1].review_note).toBe('merch → #231');
  expect(rows[2].review_note).toBe('alias → #228');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.date).toBe('2026-07-05');
  expect(result.line).toContain('3 нових');
});

test('github comment failure: affected orphan stays untriaged, others proceed', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 1, review_class: 'matcher_bug', review_note: 'x', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'unidentifiable', review_note: 'y', issue_number: null, new_issue_key: null },
    ],
    new_issues: [],
  };
  const github = gh({ commentOnIssue: vi.fn().mockRejectedValue(new Error('boom')) });
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });
  const cls = (id: number) => (d.prepare(
    'SELECT review_class FROM enrich_failures WHERE beer_id = ?',
  ).get(id) as { review_class: string | null }).review_class;
  expect(cls(1)).toBeNull();   // GitHub failed → no DB write
  expect(cls(2)).toBe('unidentifiable');
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.line).toContain('пропущено');
});

test('LLM failure: nothing written except error result line', async () => {
  const d = db();
  seedOrphan(d, 1);
  const github = gh();
  await orphanTriage({
    db: d, log, github, now: inWindow,
    llm: { analyze: vi.fn().mockRejectedValue(new Error('invalid json')) },
  });
  expect(github.createIssue).not.toHaveBeenCalled();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('помилка');
  // run is still marked so we don't hammer a broken LLM every 15 min
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('LLM rejecting with a non-Error (plain string) still writes error line and marks the run', async () => {
  const d = db();
  seedOrphan(d, 1);
  const github = gh();
  await orphanTriage({
    db: d, log, github, now: inWindow,
    llm: { analyze: vi.fn().mockImplementation(() => Promise.reject('raw string failure')) },
  });
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.line).toContain('помилка');
  expect(result.line).toContain('raw string failure');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('github createIssue failure: its verdicts stay untriaged, other groups proceed', async () => {
  const d = db();
  [1, 2, 3].forEach((n) => seedOrphan(d, n));
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 1, review_class: 'parser_bug', review_note: 'merch', issue_number: null, new_issue_key: 'k1' },
      { beer_id: 2, review_class: 'matcher_bug', review_note: 'alias', issue_number: 228, new_issue_key: null },
      { beer_id: 3, review_class: 'unidentifiable', review_note: 'y', issue_number: null, new_issue_key: null },
    ],
    new_issues: [{
      key: 'k1', title: 'Adapter noise', body: 'b', labels: [], scope: { beer_ids: [1, 2, 3, 4, 5, 6], where: [] },
    }],
  };
  const github = gh({ createIssue: vi.fn().mockRejectedValue(new Error('boom')) });
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });
  const cls = (id: number) => (d.prepare(
    'SELECT review_class FROM enrich_failures WHERE beer_id = ?',
  ).get(id) as { review_class: string | null }).review_class;
  expect(cls(1)).toBeNull();          // createIssue failed → no DB write
  expect(cls(2)).toBe('matcher_bug'); // comment group still proceeds
  expect(cls(3)).toBe('unidentifiable');     // quiet group still proceeds
  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.line).toContain('1 пропущено');
});

test('disabled (no llm/github): skip line written once', async () => {
  const d = db();
  await orphanTriage({ db: d, log, llm: null, github: null, now: inWindow });
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('вимкнено');
});

test('no untriaged orphans: nothing-to-do line, no LLM call', async () => {
  const d = db();
  const theLlm = llm({ verdicts: [], new_issues: [] });
  const github = gh();
  await orphanTriage({ db: d, log, llm: theLlm, github, now: inWindow });
  expect(theLlm.analyze).not.toHaveBeenCalled();
  expect(github.listOpenIssues).not.toHaveBeenCalled();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('0 нових');
});

test('reentrancy guard: overlapping tick is skipped while a run is in progress', async () => {
  const d = db();
  seedOrphan(d, 1);
  let resolveAnalyze!: (v: ReturnType<typeof exchange>) => void;
  const deferred = new Promise<ReturnType<typeof exchange>>((resolve) => { resolveAnalyze = resolve; });
  const theLlm = { analyze: vi.fn().mockReturnValue(deferred) };
  const github = gh();

  const first = orphanTriage({ db: d, log, llm: theLlm, github, now: inWindow });
  // Let the first run's synchronous prefix (including the `await
  // github.listOpenIssues()` continuation) progress up to the pending
  // `llm.analyze()` call before the "next tick" fires.
  await new Promise((resolve) => { setImmediate(resolve); });

  const second = orphanTriage({ db: d, log, llm: theLlm, github, now: inWindow });
  await second;
  expect(theLlm.analyze).toHaveBeenCalledTimes(1);
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();

  resolveAnalyze(exchange({
    verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'x', issue_number: null, new_issue_key: null }],
    new_issues: [],
  }));
  await first;
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('buildTriageLine formats counts', () => {
  expect(buildTriageLine({
    total: 7, commented: [{ issueNumber: 228, count: 2 }], created: [{ issueNumber: 232, count: 1 }],
    notOnUntappd: 3, unidentifiable: 0, notABeer: 0, causeStripped: 0, noTarget: 0, guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 }, skipped: 1, unverified: 0, error: null, attempt: null, disabledReason: null,
  })).toBe('Тріаж: 7 нових → 2 до #228, 1 нова #232, 3 not_on_untappd, 1 пропущено');
  expect(buildTriageLine({
    total: 0, commented: [], created: [], notOnUntappd: 0, unidentifiable: 0, notABeer: 0, causeStripped: 0, noTarget: 0, guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 },
    skipped: 0, unverified: 0, error: 'invalid json', attempt: null, disabledReason: null,
  })).toBe('Тріаж: помилка (invalid json)');
  expect(buildTriageLine({
    total: 0, commented: [], created: [], notOnUntappd: 0, unidentifiable: 0, notABeer: 0, causeStripped: 0, noTarget: 0, guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 },
    skipped: 0, unverified: 0, error: null, attempt: null, disabledReason: 'нема GITHUB_TOKEN',
  })).toBe('Тріаж: вимкнено (нема GITHUB_TOKEN)');
});

test('guardHits reaches the run outcome even when no guard fired', async () => {
  const d = db();
  seedOrphan(d, 1);
  const spy = vi.spyOn(log, 'info');
  const theLlm = llm({
    verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'x',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  });
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: expect.objectContaining({
        guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 },
      }),
    }),
    'orphan-triage finished',
  );
  spy.mockRestore();
});

test('guardHits reaches the outcome when a guard fired and every row got a verdict', async () => {
  const d = db();
  seedOrphan(d, 1);
  const spy = vi.spyOn(log, 'info');
  // not_on_untappd with no probe evidence: guard 3 fires, covered === batch, so the old
  // `verdict shortfall` condition is false — this is the 2026-08-16 shape exactly.
  const theLlm = llm({
    verdicts: [{ beer_id: 1, review_class: 'not_on_untappd', review_note: 'absent',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  });
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: expect.objectContaining({
        guardHits: expect.objectContaining({ unprobed_absence: 1 }),
      }),
    }),
    'orphan-triage finished',
  );
  spy.mockRestore();
});

test('verdict shortfall still warns and no longer carries guardHits', async () => {
  const d = db();
  seedOrphan(d, 1);
  seedOrphan(d, 2);
  const spy = vi.spyOn(log, 'warn');
  const theLlm = llm({
    verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'x',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  });
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  // Exact object, not objectContaining: equality is what proves guardHits is gone.
  expect(spy).toHaveBeenCalledWith({ covered: 1, batch: 2 }, 'orphan-triage: verdict shortfall');
  spy.mockRestore();
});

test('empty verdicts: retries once; still empty → error line, run marked, nothing written', async () => {
  const d = db();
  seedOrphan(d, 1);
  const emptyEx = exchange({ verdicts: [], new_issues: [] }, 'end_turn');
  const analyze = vi.fn().mockResolvedValue(emptyEx);
  const github = gh();
  await orphanTriage({ db: d, log, llm: { analyze }, github, now: inWindow });

  expect(analyze).toHaveBeenCalledTimes(2);            // one retry
  expect(github.createIssue).not.toHaveBeenCalled();
  expect(github.commentOnIssue).not.toHaveBeenCalled();
  const cls = (d.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = 1')
    .get() as { review_class: string | null }).review_class;
  expect(cls).toBeNull();                              // untriaged → re-enters tomorrow
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.line).toContain('помилка');
  expect(result.line).toContain('0 вердиктів');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('empty verdicts then non-empty retry: proceeds normally', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  const good = exchange({
    verdicts: [
      { beer_id: 1, review_class: 'matcher_bug', review_note: 'x', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'unidentifiable', review_note: 'y', issue_number: null, new_issue_key: null },
    ],
    new_issues: [],
  });
  const analyze = vi.fn()
    .mockResolvedValueOnce(exchange({ verdicts: [], new_issues: [] }, 'end_turn'))
    .mockResolvedValueOnce(good);
  const github = gh();
  await orphanTriage({ db: d, log, llm: { analyze }, github, now: inWindow });

  expect(analyze).toHaveBeenCalledTimes(2);
  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  const cls = (id: number) => (d.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?')
    .get(id) as { review_class: string | null }).review_class;
  expect(cls(1)).toBe('matcher_bug');
  expect(cls(2)).toBe('unidentifiable');
});

test('partial shortfall: fewer verdicts than batch → still processes, run marked', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  // Only beer_id 1 gets a verdict; beer_id 2 is uncovered (shortfall).
  const analyze = vi.fn().mockResolvedValue(exchange({
    verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'x', issue_number: null, new_issue_key: null }],
    new_issues: [],
  }));
  const github = gh();
  await orphanTriage({ db: d, log, llm: { analyze }, github, now: inWindow });

  expect(analyze).toHaveBeenCalledTimes(1);             // non-empty → no retry
  const cls = (id: number) => (d.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?')
    .get(id) as { review_class: string | null }).review_class;
  expect(cls(1)).toBe('unidentifiable');
  expect(cls(2)).toBeNull();                            // uncovered → re-enters tomorrow
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
});

test('archive: write called once with both exchanges', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analyze = vi.fn()
    .mockResolvedValueOnce(exchange({ verdicts: [], new_issues: [] }, 'end_turn'))
    .mockResolvedValueOnce(exchange({
      verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'x', issue_number: null, new_issue_key: null }],
      new_issues: [],
    }));
  const archive = { write: vi.fn().mockResolvedValue(undefined) };
  await orphanTriage({ db: d, log, llm: { analyze }, github: gh(), archive, now: inWindow });

  expect(archive.write).toHaveBeenCalledTimes(1);
  const [dateKey, payload] = archive.write.mock.calls[0];
  expect(dateKey).toBe('2026-07-05');
  expect((payload as { exchanges: unknown[] }).exchanges).toHaveLength(2);
  expect((payload as { batchSize: number }).batchSize).toBe(1);
});

test('archive: zero-verdict-after-retry run is still archived (both empty exchanges)', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analyze = vi.fn().mockResolvedValue(exchange({ verdicts: [], new_issues: [] }, 'end_turn'));
  const archive = { write: vi.fn().mockResolvedValue(undefined) };
  await orphanTriage({ db: d, log, llm: { analyze }, github: gh(), archive, now: inWindow });

  // The zero-verdict path is the whole point of the archive — it must persist
  // both attempts even though the run ends in an error line.
  expect(analyze).toHaveBeenCalledTimes(2);
  expect(archive.write).toHaveBeenCalledTimes(1);
  expect((archive.write.mock.calls[0][1] as { exchanges: unknown[] }).exchanges).toHaveLength(2);
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('помилка');
});

// --- evidence pipeline (2026-07-28): probes + cause verification ---

const searchStub = (results: unknown[] = []) => ({ search: vi.fn().mockResolvedValue(results) });

const petrusHit = {
  bid: 6682946, beer_name: 'Petrus Kriek', brewery_name: 'Brouwerij De Brabandere',
  style: null, abv: 4, global_rating: null,
};

// A created issue must be born SCOPED, or guard 2 could never let a row attach to it
// tomorrow — the block is rendered by us from the model's structured field.
test('a created issue body carries the triage-scope block', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{
      beer_id: 1, review_class: 'matcher_bug', review_note: 'n',
      issue_number: null, new_issue_key: 'k1',
    }],
    new_issues: [{
      key: 'k1', title: 't', body: 'prose about the pattern', labels: [],
      scope: { beer_ids: [1], where: [] },
    }],
  };
  const github = gh();
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });

  const body = (github.createIssue.mock.calls[0][0] as { body: string }).body;
  expect(body).toContain('prose about the pattern');
  expect(body).toContain('```triage-scope');
  expect(parseScopeBlock(body)).toEqual({ beer_ids: [1], where: [] });
});

test('guardHits on the finished outcome carries per-guard counts', async () => {
  const d = db();
  seedOrphan(d, 1);
  seedOrphan(d, 2);
  const infos: Record<string, unknown>[] = [];
  const spyLog = { ...log, warn: () => {}, error: () => {}, debug: () => {},
    info: (o: unknown) => { infos.push(o as Record<string, unknown>); } } as unknown as typeof log;
  // A verdict for beer 2 only (so `covered` falls short), pointing at an issue whose
  // scope it violates: seedOrphan writes candidates_count 0, the scope demands > 0.
  const analysis: Analysis = {
    verdicts: [{
      beer_id: 2, review_class: 'matcher_bug', review_note: 'n',
      issue_number: 228, new_issue_key: null,
    }],
    new_issues: [],
  };
  await orphanTriage({
    db: d, log: spyLog, llm: llm(analysis),
    github: gh({ listOpenIssues: vi.fn().mockResolvedValue([{
      number: 228, title: 't', labels: [], createdAt: '2026-01-01T00:00:00.000Z',
      body: '```triage-scope\n{"beer_ids":[],"where":[{"col":"candidates_count","op":">","value":0}]}\n```',
    }]) }),
    now: inWindow,
  });

  const line = infos.find((l) => l.dateKey !== undefined
    && (l.outcome as { guardHits?: Record<string, number> } | undefined)?.guardHits);
  expect(line).toBeDefined();
  const outcome = line!.outcome as { guardHits: Record<string, number> };
  expect(outcome.guardHits.scope_violation).toBe(1);
});

// The other side of #408 guard 3: with a search dep the probes actually run, and an
// empty result IS evidence of absence, so the terminal class survives end to end. This
// is what stops the guard from collapsing into "always degrade".
test('not_on_untappd survives the job when the probes ran and found nothing', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{
      beer_id: 1, review_class: 'not_on_untappd', review_note: 'small batch',
      issue_number: null, new_issue_key: null,
    }],
    new_issues: [],
  };
  await orphanTriage({
    db: d, log, llm: llm(analysis), github: gh(), search: searchStub(), now: inWindow,
  });

  const row = d.prepare('SELECT review_class, review_note FROM enrich_failures WHERE beer_id = 1')
    .get() as { review_class: string; review_note: string };
  expect(row.review_class).toBe('not_on_untappd');
  expect(row.review_note).toBe('small batch');
});

test('an unverified cause is downgraded: no GitHub write, note prefixed', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{
      beer_id: 1, review_class: 'matcher_bug', review_note: 'brewery alias gap',
      issue_number: 228, new_issue_key: null,
      proposed_query: 'ReCraft Hazy American Pale Ale',
      expected_target: 'Browar Cornelius — Cornelius Hazy APA',
    }],
    new_issues: [],
  };
  const github = gh();
  // probes return nothing; the verification query returns nothing either
  await orphanTriage({ db: d, log, llm: llm(analysis), github, search: searchStub(), now: inWindow });

  expect(github.commentOnIssue).not.toHaveBeenCalled();
  const row = d.prepare('SELECT review_class, review_note FROM enrich_failures WHERE beer_id = 1')
    .get() as { review_class: string; review_note: string };
  expect(row.review_class).toBe('matcher_bug');
  expect(row.review_note).toMatch(/^unverified: /);
  expect(row.review_note).not.toContain('#228');
});

test('a verified cause is published as before', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{
      beer_id: 1, review_class: 'matcher_bug', review_note: 'brand of De Brabandere',
      issue_number: 228, new_issue_key: null,
      proposed_query: 'Petrus Kriek',
      expected_target: 'Brouwerij De Brabandere — Petrus Kriek',
    }],
    new_issues: [],
  };
  const github = gh();
  await orphanTriage({
    db: d, log, llm: llm(analysis), github, search: searchStub([petrusHit]), now: inWindow,
  });

  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  const row = d.prepare('SELECT review_note FROM enrich_failures WHERE beer_id = 1')
    .get() as { review_note: string };
  expect(row.review_note).toContain('#228');
  expect(row.review_note).not.toMatch(/^unverified: /);
});

test('probes run for zero-candidate orphans and reach the prompt input', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'not_on_untappd', review_note: 'absent',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  };
  const theLlm = llm(analysis);
  const search = searchStub([petrusHit]);
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), search, now: inWindow });

  // brewery-only + name-only for the single zero-candidate row
  expect(search.search).toHaveBeenCalledTimes(2);
  expect(theLlm.analyze.mock.calls[0][0].probes.get(1).brewery).toContain('Petrus Kriek');
});

test('a search dep that throws never fails the run', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'matcher_bug', review_note: 'alias',
      issue_number: 228, new_issue_key: null,
      proposed_query: 'q', expected_target: 'A — B' }],
    new_issues: [],
  };
  const github = gh();
  const search = { search: vi.fn().mockRejectedValue(new Error('breaker open')) };
  await orphanTriage({ db: d, log, llm: llm(analysis), github, search, now: inWindow });

  const row = d.prepare('SELECT review_class, review_note FROM enrich_failures WHERE beer_id = 1')
    .get() as { review_class: string; review_note: string };
  expect(row.review_class).toBe('matcher_bug');
  expect(row.review_note).toMatch(/^unverified: /);
  expect(github.commentOnIssue).not.toHaveBeenCalled();
});

test('without a search dep the job behaves exactly as before', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'matcher_bug', review_note: 'alias',
      issue_number: 228, new_issue_key: null }],
    new_issues: [],
  };
  const github = gh();
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });

  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  const row = d.prepare('SELECT review_note FROM enrich_failures WHERE beer_id = 1')
    .get() as { review_note: string };
  expect(row.review_note).toContain('#228');
});

// #432: the digest's "неперевірених" part now reads causeStripped (the disjoint,
// row-counting field), not unverified — publishing both was the double-count bug
// (see the TriageOutcome comment). causeStripped and unverified are deliberately
// set to DIFFERENT values here: if the implementation regressed to rendering
// o.unverified, the digest would show "7 неперевірених" instead of the asserted
// "2 неперевірених" and this test would go red. Equal values would prove nothing.
test('buildTriageLine reports the causeStripped count, not unverified', () => {
  expect(buildTriageLine({
    total: 4, commented: [{ issueNumber: 228, count: 1 }], created: [],
    notOnUntappd: 1, unidentifiable: 0, notABeer: 0, causeStripped: 2, noTarget: 0, guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 }, skipped: 0, unverified: 7,
    error: null, attempt: null, disabledReason: null,
  })).toBe('Тріаж: 4 нових → 1 до #228, 1 not_on_untappd, 2 неперевірених');
});

test('logs one evidence summary per run (input for the quality review)', async () => {
  const d = db();
  seedOrphan(d, 1);
  const lines: Record<string, unknown>[] = [];
  const spyLog = { ...log, info: (o: unknown) => { lines.push(o as Record<string, unknown>); },
    warn: () => {}, error: () => {}, debug: () => {} } as unknown as typeof log;
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'matcher_bug', review_note: 'alias',
      issue_number: 228, new_issue_key: null, proposed_query: 'q', expected_target: 'A — B' }],
    new_issues: [],
  };
  await orphanTriage({
    db: d, log: spyLog, llm: llm(analysis), github: gh(),
    search: { search: vi.fn().mockRejectedValue(new Error('breaker open')) }, now: inWindow,
  });

  const summary = lines.find((l) => typeof l === 'object' && l !== null && 'rowsWithEvidence' in l);
  expect(summary).toMatchObject({ probeFailures: 2, causesChecked: 1, unverified: 1, verifyFailures: 1 });
});

test('buildTriageLine: transient attempts vs final failure', () => {
  const base = {
    total: 5, commented: [], created: [], notOnUntappd: 0, unidentifiable: 0, notABeer: 0, causeStripped: 0, noTarget: 0, guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 0, unprobed_absence: 0 },
    skipped: 0, unverified: 0, error: null as string | null, disabledReason: null as string | null,
    attempt: null as number | null,
  };
  expect(buildTriageLine({ ...base, error: '500 Internal server error', attempt: 1 }))
    .toBe('Тріаж: тимчасова помилка (500 Internal server error), спроба 1/3');
  expect(buildTriageLine({ ...base, error: '500 Internal server error', attempt: TRIAGE_MAX_ATTEMPTS }))
    .toBe('Тріаж: помилка (500 Internal server error, 3 спроби)');
  // Permanent errors keep the pre-#316 wording.
  expect(buildTriageLine({ ...base, error: 'invalid json', attempt: null }))
    .toBe('Тріаж: помилка (invalid json)');
  expect(buildTriageLine({ ...base, disabledReason: 'нема ключа LLM', attempt: null }))
    .toBe('Тріаж: вимкнено (нема ключа LLM)');
  expect(buildTriageLine({ ...base, attempt: null })).toContain('5 нових');
});

// #316: a transient upstream failure must not consume the Warsaw day.
const transientLlm = () => ({
  analyze: vi.fn().mockRejectedValue(new HttpStatusError('triage LLM: OpenAI HTTP 500: oops', 500)),
});

test('transient LLM failure: day stays open, attempt counter and soft line written', async () => {
  const d = db();
  seedOrphan(d, 1);
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });

  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();      // day NOT consumed
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
  const result = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!);
  expect(result.date).toBe('2026-07-05');                       // visible in today's digest
  expect(result.line).toContain('тимчасова помилка');
  expect(result.line).toContain('спроба 1/3');
});

test('transient failures: the third attempt closes the day', async () => {
  const d = db();
  seedOrphan(d, 1);
  const theLlm = transientLlm();
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  // Intermediate value: still open after the second (of three) attempts.
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:2');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });

  expect(theLlm.analyze).toHaveBeenCalledTimes(TRIAGE_MAX_ATTEMPTS);
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('3 спроби');

  // A fourth tick in the same window is skipped by the idempotency check.
  await orphanTriage({ db: d, log, llm: theLlm, github: gh(), now: inWindow });
  expect(theLlm.analyze).toHaveBeenCalledTimes(TRIAGE_MAX_ATTEMPTS);
});

test('no duplicate GitHub side effects across a transient retry', async () => {
  const d = db();
  [1, 2].forEach((n) => seedOrphan(d, n));
  const analysis: Analysis = {
    verdicts: [
      { beer_id: 1, review_class: 'matcher_bug', review_note: 'alias', issue_number: 228, new_issue_key: null },
      { beer_id: 2, review_class: 'parser_bug', review_note: 'merch', issue_number: null, new_issue_key: 'k1' },
    ],
    new_issues: [{
      key: 'k1', title: 'Adapter noise', body: 'b', labels: [], scope: { beer_ids: [1, 2, 3, 4, 5, 6], where: [] },
    }],
  };
  // One github stub shared across both ticks, so call counts accumulate.
  const github = gh();
  await orphanTriage({ db: d, log, llm: transientLlm(), github, now: inWindow });
  await orphanTriage({ db: d, log, llm: llm(analysis), github, now: inWindow });

  expect(github.createIssue).toHaveBeenCalledTimes(1);
  expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
});

test('a permanent failure after a transient one closes the day with pre-#316 wording', async () => {
  const d = db();
  seedOrphan(d, 1);
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');

  await orphanTriage({
    db: d, log, github: gh(), now: inWindow,
    llm: { analyze: vi.fn().mockRejectedValue(new Error('triage LLM: invalid response shape')) },
  });

  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  const line = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line;
  expect(line).toContain('помилка');
  expect(line).not.toContain('спроба');
});

test('transient then success: normal result line, day closed', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'y', issue_number: null, new_issue_key: null }],
    new_issues: [],
  };
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });
  await orphanTriage({ db: d, log, llm: llm(analysis), github: gh(), now: inWindow });

  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  const line = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line;
  expect(line).toContain('1 нових');
  expect(line).not.toContain('помилка');
});

test('closing the day clears the attempt counter', async () => {
  const d = db();
  seedOrphan(d, 1);
  const analysis: Analysis = {
    verdicts: [{ beer_id: 1, review_class: 'unidentifiable', review_note: 'y', issue_number: null, new_issue_key: null }],
    new_issues: [],
  };
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
  await orphanTriage({ db: d, log, llm: llm(analysis), github: gh(), now: inWindow });
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBeNull();
});

test('permanent LLM failure: day is consumed on the first attempt', async () => {
  const d = db();
  seedOrphan(d, 1);
  await orphanTriage({
    db: d, log, github: gh(), now: inWindow,
    llm: { analyze: vi.fn().mockRejectedValue(new Error('triage LLM: invalid response shape')) },
  });
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBe('2026-07-05');
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBeNull();
  const line = JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line;
  expect(line).toContain('помилка');
  expect(line).not.toContain('спроба');
});

test('attempt counter from an earlier date does not count against today', async () => {
  const d = db();
  seedOrphan(d, 1);
  setJobState(d, TRIAGE_ATTEMPTS_KEY, '2026-07-04:2');
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });

  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('спроба 1/3');
});

test('transient GitHub failure on listOpenIssues is retried too', async () => {
  const d = db();
  seedOrphan(d, 1);
  const github = gh({
    listOpenIssues: vi.fn().mockRejectedValue(new HttpStatusError('GitHub GET …: 502 bad gateway', 502)),
  });
  await orphanTriage({ db: d, log, llm: llm({ verdicts: [], new_issues: [] }), github, now: inWindow });

  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();
  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
});

test('corrupted attempt counter is ignored instead of widening the budget', async () => {
  const d = db();
  seedOrphan(d, 1);
  // A hand-edited/garbled value must not read as a negative or fractional count:
  // `-100` would otherwise mean attempt -99 < TRIAGE_MAX_ATTEMPTS forever.
  setJobState(d, TRIAGE_ATTEMPTS_KEY, '2026-07-05:-100');
  await orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), now: inWindow });

  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('спроба 1/3');
});

test('narrow warn fires for scope_violation with no shortfall', () => {
  const warn = vi.fn();
  reportGuardAnomalies({ warn } as never, {
    illegal_scope: 0, scope_violation: 2, saturated: 0, unprobed_absence: 0,
  });
  expect(warn).toHaveBeenCalledTimes(1);
});

test('narrow warn fires for illegal_scope with no shortfall', () => {
  const warn = vi.fn();
  reportGuardAnomalies({ warn } as never, {
    illegal_scope: 1, scope_violation: 0, saturated: 0, unprobed_absence: 0,
  });
  expect(warn).toHaveBeenCalledTimes(1);
});

test('narrow warn stays silent for routine guard work', () => {
  const warn = vi.fn();
  reportGuardAnomalies({ warn } as never, {
    illegal_scope: 0, scope_violation: 0, saturated: 5, unprobed_absence: 9,
  });
  expect(warn).not.toHaveBeenCalled();
});

// #432: causeStripped and unverified are deliberately UNEQUAL in both fixtures below —
// a regression to rendering o.unverified would show "8 неперевірених" in the first case
// and a spurious "3 неперевірених" part (unverified: 3, causeStripped: 0 should render
// nothing) in the second. Equal values would let a wrong field pass silently.
test('buildTriageLine names each quiet mechanism and hides routine guards', () => {
  expect(buildTriageLine({
    total: 15, commented: [], created: [], notOnUntappd: 0, unidentifiable: 0, notABeer: 0,
    causeStripped: 5, noTarget: 1, skipped: 0, unverified: 8,
    guardHits: { illegal_scope: 0, scope_violation: 0, saturated: 4, unprobed_absence: 9 },
    error: null, attempt: null, disabledReason: null,
  })).toBe('Тріаж: 15 нових → 9 без доказу відсутності, 5 неперевірених, 1 без цілі');

  expect(buildTriageLine({
    total: 3, commented: [], created: [], notOnUntappd: 0, unidentifiable: 0, notABeer: 0,
    causeStripped: 0, noTarget: 0, skipped: 2, unverified: 3,
    guardHits: { illegal_scope: 1, scope_violation: 2, saturated: 0, unprobed_absence: 0 },
    error: null, attempt: null, disabledReason: null,
  })).toBe('Тріаж: 3 нових → 1 нелегальний scope, 2 поза scope, 2 пропущено');
});

test('a throwing archive cannot cost the day: state is written before the archive', async () => {
  const d = db();
  seedOrphan(d, 1);
  // TriageArchive is documented never-throws, but the day accounting must not
  // depend on another module honouring that.
  const archive = { write: vi.fn().mockRejectedValue(new Error('disk full')) };
  await expect(
    orphanTriage({ db: d, log, llm: transientLlm(), github: gh(), archive, now: inWindow }),
  ).rejects.toThrow('disk full');

  expect(getJobState(d, TRIAGE_ATTEMPTS_KEY)).toBe('2026-07-05:1');
  expect(getJobState(d, TRIAGE_LAST_RUN_KEY)).toBeNull();
  expect(JSON.parse(getJobState(d, TRIAGE_LAST_RESULT_KEY)!).line).toContain('спроба 1/3');
});
