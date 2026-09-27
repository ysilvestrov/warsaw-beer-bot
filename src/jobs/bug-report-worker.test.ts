import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BugReportWorkerDeps, IssueDetail, NewBugReport, RawVerdict, ReportOutcome } from '../domain/bug-report-types';
import { InvalidVerdictOutputError } from '../domain/bug-report-types';
import { HttpStatusError } from '../domain/transient-error';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { bugReportStore } from '../storage/bug_reports';
import { getJobState, setJobState } from '../storage/job_state';
import { BUG_REPORT_PAUSED_KEY, createBugReportWorker } from './bug-report-worker';

const NOW = '2026-09-26T12:00:00.000Z';
const report: NewBugReport = {
  telegramId: 101, chatId: 202, statusMessageId: 303, locale: 'uk', city: 'Warsaw',
  source: 'bot', category: 'wrong_beer', text: 'Wrong beer appears', createdAt: NOW,
};
const openIssue: IssueDetail = {
  number: 77, title: 'Existing issue', state: 'open', labels: ['bug'],
  createdAt: '2026-08-01T00:00:00Z', closedAt: null, body: 'Existing body',
  stateReason: null, comments: [{ createdAt: '2026-08-02T00:00:00Z', body: 'Prior report' }],
};
const closedIssue: IssueDetail = {
  ...openIssue, number: 78, state: 'closed', closedAt: '2026-09-20T11:00:00Z', stateReason: 'completed',
};
const raw: RawVerdict = {
  verdict: 'new', issueNumber: null, labels: ['bug'], severity: 'Severity-3',
  effort: 'effort/M', title: 'Wrong beer shown', summary: 'The rating belongs to another beer',
  where: 'Bot tap list', subjects: ['Beer A'], expected: 'Beer A rating',
  actual: 'Beer B rating', steps: ['Open tap list'], screenEvidence: [], newEvidence: 'Different rating',
};

let db: DB;
let deps: BugReportWorkerDeps;
let outcomes: { id: number; outcome: ReportOutcome }[];

function addReport(overrides: Partial<NewBugReport> = {}): number {
  return bugReportStore.insertReport(db, { ...report, ...overrides });
}
function row(id: number) {
  return bugReportStore.getReport(db, id);
}
function run() {
  return createBugReportWorker(deps).runOnce();
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  outcomes = [];
  deps = {
    db, store: bugReportStore,
    github: {
      listIssuesByLabels: vi.fn(async () => [openIssue, closedIssue]),
      getIssueWithComments: vi.fn(async (n) => n === 78 ? closedIssue : openIssue),
      createIssue: vi.fn(async () => 991),
      commentOnIssue: vi.fn(async () => undefined),
    },
    selector: { select: vi.fn(async () => ({ numbers: [77], truncated: false })) },
    judge: { judge: vi.fn(async () => raw) },
    readFile: vi.fn(async (path) => Buffer.from('contents:' + path)),
    notify: vi.fn(async (r, outcome) => { outcomes.push({ id: r.id, outcome }); }),
    latestExtensionVersion: vi.fn(() => '0.17.0'),
    now: () => new Date(NOW),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
afterEach(() => db.close());

test('new verdict creates a rendered issue with labels and records the returned number', async () => {
  const id = addReport();
  await run();
  expect(deps.github.createIssue).toHaveBeenCalledWith({
    title: 'Wrong beer shown',
    body: expect.stringContaining('Скарга R-' + id + ' · медіа: немає'),
    labels: ['bug', 'user-report', 'Severity-3', 'effort/M'],
  });
  expect(deps.github.createIssue).toHaveBeenCalledOnce();
  expect(row(id)).toMatchObject({ status: 'done', verdict: 'new', issueNumber: 991, attempts: 0 });
  expect(outcomes).toEqual([{ id, outcome: { kind: 'created', issueNumber: 991 } }]);
});

test('open duplicate comments on the selected issue and reports its number', async () => {
  const id = addReport();
  vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, verdict: 'duplicate_open', issueNumber: 77 });
  await run();
  expect(deps.github.commentOnIssue).toHaveBeenCalledWith(77, expect.stringContaining('**Нове в цій скарзі:** Different rating'));
  expect(deps.github.createIssue).not.toHaveBeenCalled();
  expect(row(id)).toMatchObject({ status: 'done', verdict: 'duplicate_open', issueNumber: 77 });
  expect(outcomes).toEqual([{ id, outcome: { kind: 'duplicate_open', issueNumber: 77 } }]);
});

test.each([['completed', true], ['not_planned', false]] as const)(
  'closed duplicate with state reason %s reports fixed = %s', async (reason, fixed) => {
    const id = addReport();
    vi.mocked(deps.selector.select).mockResolvedValue({ numbers: [78], truncated: false });
    vi.mocked(deps.github.getIssueWithComments).mockResolvedValue({ ...closedIssue, stateReason: reason });
    vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, verdict: 'duplicate_closed', issueNumber: 78 });
    await run();
    expect(deps.github.commentOnIssue).toHaveBeenCalledWith(78, expect.stringContaining('**Нове в цій скарзі:** Different rating'));
    expect(outcomes).toEqual([{ id, outcome: {
      kind: 'duplicate_closed', issueNumber: 78, closedAt: '2026-09-20T11:00:00Z', fixed,
    } }]);
  },
);

test('not a bug finishes without writing to GitHub', async () => {
  const id = addReport();
  vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, verdict: 'not_a_bug' });
  await run();
  expect(deps.github.createIssue).not.toHaveBeenCalled();
  expect(deps.github.commentOnIssue).not.toHaveBeenCalled();
  expect(row(id)).toMatchObject({ status: 'done', verdict: 'not_a_bug', issueNumber: null });
  expect(outcomes).toEqual([{ id, outcome: { kind: 'not_a_bug' } }]);
});

test('a publishing row becomes needs review without any GitHub or model call', async () => {
  const id = addReport();
  deps.store.markPublishing(db, id);
  await run();
  expect(row(id)).toMatchObject({ status: 'needs_review', processedAt: NOW });
  expect(outcomes).toEqual([{ id, outcome: { kind: 'needs_review' } }]);
  expect(deps.github.listIssuesByLabels).not.toHaveBeenCalled();
  expect(deps.github.createIssue).not.toHaveBeenCalled();
  expect(deps.github.commentOnIssue).not.toHaveBeenCalled();
  expect(deps.selector.select).not.toHaveBeenCalled();
  expect(deps.judge.judge).not.toHaveBeenCalled();
});

test('a transient create failure after publishing needs review and is never retried', async () => {
  const id = addReport();
  vi.mocked(deps.github.createIssue).mockRejectedValue(new HttpStatusError('unavailable', 503));
  await run();
  expect(row(id)).toMatchObject({ status: 'needs_review', attempts: 0 });
  expect(deps.github.createIssue).toHaveBeenCalledOnce();
  expect(outcomes).toEqual([{ id, outcome: { kind: 'needs_review' } }]);
});

test('a transient selector failure records one attempt and stops before the next row', async () => {
  const first = addReport();
  const second = addReport();
  vi.mocked(deps.selector.select).mockRejectedValueOnce(new HttpStatusError('unavailable', 503));
  await run();
  expect(row(first)).toMatchObject({ status: 'queued', attempts: 1 });
  expect(row(second)).toMatchObject({ status: 'queued', attempts: 0 });
  expect(deps.selector.select).toHaveBeenCalledOnce();
});

test('third transient failure marks the report failed', async () => {
  const id = addReport();
  db.prepare('UPDATE bug_reports SET attempts = 2 WHERE id = ?').run(id);
  vi.mocked(deps.selector.select).mockRejectedValue(new HttpStatusError('unavailable', 503));
  await run();
  expect(row(id)).toMatchObject({ status: 'failed', attempts: 3, processedAt: NOW });
  expect(outcomes).toEqual([{ id, outcome: { kind: 'failed' } }]);
});

test('a permanent selector failure fails its row and processes the next row', async () => {
  const first = addReport();
  const second = addReport();
  vi.mocked(deps.selector.select).mockRejectedValueOnce(new HttpStatusError('bad request', 400));
  await run();
  expect(row(first)).toMatchObject({ status: 'failed', attempts: 1 });
  expect(row(second)).toMatchObject({ status: 'done', verdict: 'new', issueNumber: 991 });
  expect(outcomes).toEqual([
    { id: first, outcome: { kind: 'failed' } },
    { id: second, outcome: { kind: 'created', issueNumber: 991 } },
  ]);
});

test('an invalid judge response is judged once more with the same input', async () => {
  const id = addReport();
  vi.mocked(deps.judge.judge).mockRejectedValueOnce(new InvalidVerdictOutputError('bad JSON'));
  await run();
  expect(deps.judge.judge).toHaveBeenCalledTimes(2);
  expect(vi.mocked(deps.judge.judge).mock.calls[1][0]).toEqual(vi.mocked(deps.judge.judge).mock.calls[0][0]);
  expect(row(id)?.status).toBe('done');
});

test('two invalid verdicts fail without a GitHub write', async () => {
  const id = addReport();
  vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, verdict: 'duplicate_open', issueNumber: 999 });
  await run();
  expect(deps.judge.judge).toHaveBeenCalledTimes(2);
  expect(row(id)).toMatchObject({ status: 'failed', lastError: 'Issue number is not a candidate.' });
  expect(deps.github.createIssue).not.toHaveBeenCalled();
  expect(deps.github.commentOnIssue).not.toHaveBeenCalled();
  expect(outcomes).toEqual([{ id, outcome: { kind: 'failed' } }]);
});

test('the daily cap processes the twentieth report and defers the next only once', async () => {
  for (let i = 0; i < 19; i++) {
    const id = addReport();
    deps.store.markDone(db, id, { verdict: 'not_a_bug', issueNumber: null, processedAt: NOW, related: null });
  }
  const twentieth = addReport();
  const deferred = addReport();
  const worker = createBugReportWorker(deps);
  await worker.runOnce();
  await worker.runOnce();
  expect(row(twentieth)?.status).toBe('done');
  expect(row(deferred)).toMatchObject({ status: 'queued', deferredNotified: true });
  expect(outcomes).toEqual([
    { id: twentieth, outcome: { kind: 'created', issueNumber: 991 } },
    { id: deferred, outcome: { kind: 'deferred' } },
  ]);
});

test('a report processed one millisecond before Warsaw day start does not count toward the cap', async () => {
  const previous = addReport();
  deps.store.markDone(db, previous, {
    verdict: 'not_a_bug', issueNumber: null, processedAt: '2026-09-25T21:59:59.999Z', related: null,
  });
  const current = addReport();
  deps.dailyCap = 1;
  await run();
  expect(row(current)?.status).toBe('done');
  expect(outcomes).toEqual([{ id: current, outcome: { kind: 'created', issueNumber: 991 } }]);
});

test('duplicate verdict keeps the candidate cache for the next queued report', async () => {
  addReport();
  addReport();
  vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, verdict: 'duplicate_open', issueNumber: 77 });
  await run();
  expect(deps.github.listIssuesByLabels).toHaveBeenCalledOnce();
});

test('new issue invalidates the candidate cache before the next queued report', async () => {
  addReport();
  addReport();
  await run();
  expect(deps.github.listIssuesByLabels).toHaveBeenCalledTimes(2);
});

test.each([[600_000, 1], [600_001, 2]] as const)(
  'candidate cache at elapsed %i ms makes %i list calls', async (elapsed, calls) => {
    let clock = new Date(NOW);
    deps.now = () => clock;
    vi.mocked(deps.judge.judge).mockResolvedValue({ ...raw, verdict: 'not_a_bug' });
    const worker = createBugReportWorker(deps);
    addReport();
    await worker.runOnce();
    clock = new Date(new Date(NOW).getTime() + elapsed);
    addReport();
    await worker.runOnce();
    expect(deps.github.listIssuesByLabels).toHaveBeenCalledTimes(calls);
  },
);

test('a truncated selection marks only its report', async () => {
  const id = addReport();
  vi.mocked(deps.selector.select).mockResolvedValue({ numbers: [77], truncated: true });
  await run();
  expect(row(id)?.candidatesTruncated).toBe(true);
});

test('saved supported photos reach the judge in media order with MIME types', async () => {
  const id = addReport();
  deps.store.addMedia(db, { reportId: id, idx: 2, kind: 'photo', path: '/m/b.jpg', bytes: 4 });
  deps.store.addMedia(db, { reportId: id, idx: 1, kind: 'photo', path: '/m/a.png', bytes: 4 });
  deps.store.addMedia(db, { reportId: id, idx: 3, kind: 'video', path: '/m/c.mp4', bytes: 4 });
  deps.store.addMedia(db, { reportId: id, idx: 4, kind: 'photo', path: '/m/d.png', bytes: 0 });
  deps.store.addMedia(db, { reportId: id, idx: 5, kind: 'photo', path: '/m/e.webp', bytes: 4 });
  deps.store.markMediaPruned(db, id, 5, NOW);
  deps.store.addMedia(db, { reportId: id, idx: 6, kind: 'photo', path: '/m/f.gif', bytes: 4 });
  await run();
  expect(vi.mocked(deps.judge.judge).mock.calls[0][0].images).toEqual([
    { mime: 'image/png', base64: Buffer.from('contents:/m/a.png').toString('base64') },
    { mime: 'image/jpeg', base64: Buffer.from('contents:/m/b.jpg').toString('base64') },
  ]);
  expect(deps.readFile).toHaveBeenCalledTimes(2);
});

test('an unreadable image is skipped and the report still finishes', async () => {
  const id = addReport();
  deps.store.addMedia(db, { reportId: id, idx: 0, kind: 'photo', path: '/m/bad.png', bytes: 4 });
  vi.mocked(deps.readFile).mockRejectedValue(new Error('gone'));
  await run();
  expect(vi.mocked(deps.judge.judge).mock.calls[0][0].images).toEqual([]);
  expect(row(id)?.status).toBe('done');
  expect(deps.log.warn).toHaveBeenCalledOnce();
});

test('extension version reaches the judge and rendered issue body', async () => {
  addReport({ source: 'extension', category: 'no_badge' });
  await run();
  expect(vi.mocked(deps.judge.judge).mock.calls[0][0].latestExtensionVersion).toBe('0.17.0');
  expect(vi.mocked(deps.github.createIssue).mock.calls[0][0].body).toContain('остання опублікована: 0.17.0');
});

test('bot reports pass null version to the judge and render an empty version', async () => {
  addReport();
  await run();
  expect(vi.mocked(deps.judge.judge).mock.calls[0][0].latestExtensionVersion).toBeNull();
  expect(vi.mocked(deps.github.createIssue).mock.calls[0][0].body).toMatch(/\| Бот \| [^|]+ \| — \|/);
  expect(deps.latestExtensionVersion).not.toHaveBeenCalled();
});

test('a second run during an active run does not process the same row', async () => {
  addReport();
  let release!: () => void;
  vi.mocked(deps.selector.select).mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({ numbers: [77], truncated: false });
  }));
  const worker = createBugReportWorker(deps);
  const first = worker.runOnce();
  await Promise.resolve();
  await worker.runOnce();
  release();
  await first;
  expect(deps.selector.select).toHaveBeenCalledOnce();
  expect(deps.github.createIssue).toHaveBeenCalledOnce();
});

test('notification failure does not change status or prevent the next report', async () => {
  const first = addReport();
  const second = addReport();
  vi.mocked(deps.notify).mockRejectedValueOnce(new Error('Telegram blocked'));
  await run();
  expect(row(first)?.status).toBe('done');
  expect(row(second)?.status).toBe('done');
  expect(deps.github.createIssue).toHaveBeenCalledTimes(2);
  expect(deps.log.warn).toHaveBeenCalledOnce();
});

test.each([401, 402, 403])('a %i from the selector pauses the queue without spending an attempt', async (status) => {
  const first = addReport();
  const second = addReport();
  vi.mocked(deps.selector.select).mockRejectedValueOnce(new HttpStatusError('refused', status));
  await run();
  expect(row(first)).toMatchObject({ status: 'queued', attempts: 0, processedAt: null });
  expect(row(second)).toMatchObject({ status: 'queued', attempts: 0 });
  expect(outcomes).toEqual([]);
  expect(deps.selector.select).toHaveBeenCalledOnce();
});

test('a 402 from the judge pauses the queue the same way', async () => {
  const id = addReport();
  vi.mocked(deps.judge.judge).mockRejectedValueOnce(new HttpStatusError('out of credit', 402));
  await run();
  expect(row(id)).toMatchObject({ status: 'queued', attempts: 0 });
  expect(outcomes).toEqual([]);
});

test('a 403 on the GitHub write after publishing still needs review', async () => {
  const id = addReport();
  vi.mocked(deps.github.createIssue).mockRejectedValueOnce(new HttpStatusError('forbidden', 403));
  await run();
  expect(row(id)).toMatchObject({ status: 'needs_review', attempts: 0 });
  expect(outcomes).toEqual([{ id, outcome: { kind: 'needs_review' } }]);
});

test('the first credential refusal records a pause with time and status', async () => {
  addReport();
  vi.mocked(deps.selector.select).mockRejectedValueOnce(new HttpStatusError('refused', 401));
  await run();
  expect(getJobState(db, BUG_REPORT_PAUSED_KEY)).toBe(
    '{"since":"2026-09-26T12:00:00.000Z","status":401}',
  );
});

test('a second credential refusal in a later run preserves the original pause', async () => {
  addReport();
  vi.mocked(deps.selector.select)
    .mockRejectedValueOnce(new HttpStatusError('refused', 401))
    .mockRejectedValueOnce(new HttpStatusError('out of credit', 402));
  await run();
  deps.now = () => new Date('2026-09-26T13:00:00.000Z');
  await run();
  expect(getJobState(db, BUG_REPORT_PAUSED_KEY)).toBe(
    '{"since":"2026-09-26T12:00:00.000Z","status":401}',
  );
});

test('a successful report clears the credential pause', async () => {
  addReport();
  setJobState(db, BUG_REPORT_PAUSED_KEY,
    '{"since":"2026-09-26T11:00:00.000Z","status":403}');
  await run();
  expect(getJobState(db, BUG_REPORT_PAUSED_KEY)).toBeNull();
});

test('a terminal not-a-bug report also clears the credential pause', async () => {
  addReport();
  setJobState(db, BUG_REPORT_PAUSED_KEY,
    '{"since":"2026-09-26T11:00:00.000Z","status":403}');
  vi.mocked(deps.judge.judge).mockResolvedValueOnce({
    ...raw, verdict: 'not_a_bug', issueNumber: null,
  });
  await run();
  expect(getJobState(db, BUG_REPORT_PAUSED_KEY)).toBeNull();
});

test('a transient 503 does not create a pause', async () => {
  addReport();
  vi.mocked(deps.selector.select).mockRejectedValueOnce(new HttpStatusError('unavailable', 503));
  await run();
  expect(getJobState(db, BUG_REPORT_PAUSED_KEY)).toBeNull();
});

test('a transient 503 does not clear an existing credential pause', async () => {
  addReport();
  setJobState(db, BUG_REPORT_PAUSED_KEY,
    '{"since":"2026-09-26T11:00:00.000Z","status":401}');
  vi.mocked(deps.selector.select).mockRejectedValueOnce(new HttpStatusError('unavailable', 503));
  await run();
  expect(getJobState(db, BUG_REPORT_PAUSED_KEY)).toBe(
    '{"since":"2026-09-26T11:00:00.000Z","status":401}',
  );
});
