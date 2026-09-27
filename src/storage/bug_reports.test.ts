import { afterEach, beforeEach, expect, test } from 'vitest';
import type { NewBugReport } from '../domain/bug-report-types';
import { openDb, type DB } from './db';
import { migrate } from './schema';
import {
  addMedia, countProcessedSince, countSubmittedSince, getReport, insertReport,
  listByStatus, listMedia, listPrunableMedia, markDeferredNotified, markDone,
  markFailed, markMediaPruned, markNeedsReview, markPublishing, recordAttemptError,
  setCandidatesTruncated, setJevResponse, summarizeSince, bugReportStore,
} from './bug_reports';

let db: DB;
const report: NewBugReport = {
  telegramId: 101, chatId: 202, statusMessageId: 303, locale: 'uk', city: 'warszawa',
  source: 'extension', category: 'no_badge', text: 'The badge is missing on this beer',
  createdAt: '2026-09-26T12:00:00.000Z',
};

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => db.close());

test('insertReport and getReport round-trip every report field', () => {
  const id = insertReport(db, report);
  expect(id).toBe(1);
  expect(getReport(db, id)).toEqual({
    ...report, id: 1, status: 'queued', attempts: 0, lastError: null,
    candidatesTruncated: false, deferredNotified: false, verdict: null,
    issueNumber: null, processedAt: null, jevJson: null, related: null,
  });
  expect(getReport(db, 999)).toBeNull();
});

test('a fresh report has no Jev response and no related issues', () => {
  const id = insertReport(db, report);
  expect(getReport(db, id)).toMatchObject({ jevJson: null, related: null });
});

test('setJevResponse stores the exact JSON on a queued report', () => {
  const id = insertReport(db, report);
  setJevResponse(db, id, '{"model":"jev","probabilities":{"i7":0.6,"none":0.4}}');
  expect(getReport(db, id)?.jevJson).toBe('{"model":"jev","probabilities":{"i7":0.6,"none":0.4}}');
});

test('setJevResponse refuses a report that is no longer queued', () => {
  const id = insertReport(db, report);
  markDone(db, id, { verdict: 'not_a_bug', issueNumber: null, processedAt: '2026-09-26T13:00:00.000Z', related: null });
  expect(() => setJevResponse(db, id, '{}')).toThrow('illegal transition done → jev_json');
});

test.each([
  [[539, 666], [539, 666]],
  [[], []],
  [null, null],
] as const)('markDone stores related %j and reads it back as %j', (related, expected) => {
  const id = insertReport(db, report);
  markDone(db, id, { verdict: 'new', issueNumber: 9, processedAt: '2026-09-26T13:00:00.000Z', related: related as number[] | null });
  expect(getReport(db, id)?.related).toEqual(expected);
});

test('listByStatus returns oldest matching reports by id', () => {
  insertReport(db, report);
  insertReport(db, { ...report, createdAt: '2026-09-25T00:00:00.000Z' });
  insertReport(db, report);
  markPublishing(db, 2);
  expect(listByStatus(db, 'queued').map((r) => r.id)).toEqual([1, 3]);
  expect(listByStatus(db, 'publishing').map((r) => r.id)).toEqual([2]);
});

test('markPublishing changes a queued report once', () => {
  const id = insertReport(db, report);
  markPublishing(db, id);
  expect(getReport(db, id)?.status).toBe('publishing');
  expect(() => markPublishing(db, id))
    .toThrow('bug_report 1: illegal transition publishing → publishing');
});

test('markDone records a new verdict directly from queued', () => {
  const id = insertReport(db, report);
  markDone(db, id, { verdict: 'not_a_bug', issueNumber: null, processedAt: '2026-09-26T13:00:00.000Z', related: null });
  expect(getReport(db, id)).toEqual({
    ...report, id: 1, status: 'done', attempts: 0, lastError: null,
    candidatesTruncated: false, deferredNotified: false, verdict: 'not_a_bug',
    issueNumber: null, processedAt: '2026-09-26T13:00:00.000Z', jevJson: null, related: null,
  });
});

test('markDone records a GitHub verdict from publishing', () => {
  const id = insertReport(db, report);
  markPublishing(db, id);
  markDone(db, id, { verdict: 'duplicate_open', issueNumber: 77, processedAt: '2026-09-26T13:00:00.000Z', related: null });
  expect(getReport(db, id)?.status).toBe('done');
  expect(getReport(db, id)?.issueNumber).toBe(77);
  expect(getReport(db, id)?.verdict).toBe('duplicate_open');
});

test('markFailed stores the error and processed time from queued', () => {
  const id = insertReport(db, report);
  markFailed(db, id, { error: 'Model timed out', processedAt: '2026-09-26T13:00:00.000Z' });
  expect(getReport(db, id)?.status).toBe('failed');
  expect(getReport(db, id)?.lastError).toBe('Model timed out');
  expect(getReport(db, id)?.processedAt).toBe('2026-09-26T13:00:00.000Z');
});

test('markNeedsReview moves only a publishing report', () => {
  const id = insertReport(db, report);
  markPublishing(db, id);
  markNeedsReview(db, id, '2026-09-26T13:00:00.000Z');
  expect(getReport(db, id)?.status).toBe('needs_review');
  expect(getReport(db, id)?.processedAt).toBe('2026-09-26T13:00:00.000Z');
});

test.each([
  ['publishing', 'markPublishing', (id: number) => markPublishing(db, id), 'publishing'],
  ['done', 'markPublishing', (id: number) => markPublishing(db, id), 'publishing'],
  ['failed', 'markPublishing', (id: number) => markPublishing(db, id), 'publishing'],
  ['needs_review', 'markPublishing', (id: number) => markPublishing(db, id), 'publishing'],
  ['done', 'markDone', (id: number) => markDone(db, id, { verdict: 'new', issueNumber: 9, processedAt: '2026-09-26T13:00:00Z', related: null }), 'done'],
  ['failed', 'markDone', (id: number) => markDone(db, id, { verdict: 'new', issueNumber: 9, processedAt: '2026-09-26T13:00:00Z', related: null }), 'done'],
  ['needs_review', 'markDone', (id: number) => markDone(db, id, { verdict: 'new', issueNumber: 9, processedAt: '2026-09-26T13:00:00Z', related: null }), 'done'],
  ['publishing', 'markFailed', (id: number) => markFailed(db, id, { error: 'error', processedAt: '2026-09-26T13:00:00Z' }), 'failed'],
  ['done', 'markFailed', (id: number) => markFailed(db, id, { error: 'error', processedAt: '2026-09-26T13:00:00Z' }), 'failed'],
  ['failed', 'markFailed', (id: number) => markFailed(db, id, { error: 'error', processedAt: '2026-09-26T13:00:00Z' }), 'failed'],
  ['needs_review', 'markFailed', (id: number) => markFailed(db, id, { error: 'error', processedAt: '2026-09-26T13:00:00Z' }), 'failed'],
  ['queued', 'markNeedsReview', (id: number) => markNeedsReview(db, id, '2026-09-26T13:00:00Z'), 'needs_review'],
  ['done', 'markNeedsReview', (id: number) => markNeedsReview(db, id, '2026-09-26T13:00:00Z'), 'needs_review'],
  ['failed', 'markNeedsReview', (id: number) => markNeedsReview(db, id, '2026-09-26T13:00:00Z'), 'needs_review'],
  ['needs_review', 'markNeedsReview', (id: number) => markNeedsReview(db, id, '2026-09-26T13:00:00Z'), 'needs_review'],
  ['publishing', 'recordAttemptError', (id: number) => recordAttemptError(db, id, 'error'), 'attempt_error'],
  ['done', 'recordAttemptError', (id: number) => recordAttemptError(db, id, 'error'), 'attempt_error'],
  ['failed', 'recordAttemptError', (id: number) => recordAttemptError(db, id, 'error'), 'attempt_error'],
  ['needs_review', 'recordAttemptError', (id: number) => recordAttemptError(db, id, 'error'), 'attempt_error'],
] as const)('rejects %s → %s', (status, _method, operation, target) => {
  const id = insertReport(db, report);
  db.prepare('UPDATE bug_reports SET status = ? WHERE id = ?').run(status, id);
  expect(() => operation(id)).toThrow(`bug_report 1: illegal transition ${status} → ${target}`);
  expect(getReport(db, id)?.status).toBe(status);
});

test('recordAttemptError increments attempts only for queued reports', () => {
  const id = insertReport(db, report);
  expect(recordAttemptError(db, id, 'first')).toBe(1);
  expect(recordAttemptError(db, id, 'second')).toBe(2);
  expect(getReport(db, id)?.attempts).toBe(2);
  expect(getReport(db, id)?.lastError).toBe('second');
});

test('candidate truncation and deferral flags persist as booleans', () => {
  const id = insertReport(db, report);
  setCandidatesTruncated(db, id);
  markDeferredNotified(db, id);
  expect(getReport(db, id)?.candidatesTruncated).toBe(true);
  expect(getReport(db, id)?.deferredNotified).toBe(true);
});

test('countSubmittedSince includes the boundary and isolates one user', () => {
  insertReport(db, { ...report, createdAt: '2026-09-26T11:59:59.999Z' });
  insertReport(db, report);
  insertReport(db, { ...report, telegramId: 102 });
  expect(countSubmittedSince(db, 101, '2026-09-26T12:00:00.000Z')).toBe(1);
  expect(countSubmittedSince(db, 102, '2026-09-26T12:00:00.000Z')).toBe(1);
  expect(countSubmittedSince(db, 103, '2026-09-26T12:00:00.000Z')).toBe(0);
});

test('countSubmittedSince includes reports regardless of processing status', () => {
  insertReport(db, report);
  insertReport(db, report);
  insertReport(db, report);
  markDone(db, 1, { verdict: 'new', issueNumber: 90, processedAt: '2026-09-26T13:00:00.000Z', related: null });
  markFailed(db, 2, { error: 'bad response', processedAt: '2026-09-26T13:00:00.000Z' });
  expect(countSubmittedSince(db, 101, '2026-09-26T12:00:00.000Z')).toBe(3);
});

test('countProcessedSince includes the boundary and excludes unprocessed reports', () => {
  insertReport(db, report);
  insertReport(db, report);
  insertReport(db, report);
  markDone(db, 1, { verdict: 'new', issueNumber: 90, processedAt: '2026-09-26T11:59:59.999Z', related: null });
  markDone(db, 2, { verdict: 'new', issueNumber: 91, processedAt: '2026-09-26T12:00:00.000Z', related: null });
  expect(countProcessedSince(db, '2026-09-26T12:00:00.000Z')).toBe(1);
});

test('summarizeSince counts every verdict and returns status lists and closed links', () => {
  for (let i = 0; i < 8; i += 1) insertReport(db, report);
  db.prepare("UPDATE bug_reports SET created_at = '2026-09-20T00:00:00.000Z' WHERE id = 5").run();
  markDone(db, 1, { verdict: 'new', issueNumber: 90, processedAt: '2026-09-26T12:00:00.000Z', related: null });
  markDone(db, 2, { verdict: 'duplicate_open', issueNumber: 91, processedAt: '2026-09-26T12:01:00.000Z', related: null });
  markDone(db, 3, { verdict: 'duplicate_closed', issueNumber: 92, processedAt: '2026-09-26T12:02:00.000Z', related: null });
  markDone(db, 4, { verdict: 'not_a_bug', issueNumber: null, processedAt: '2026-09-26T12:03:00.000Z', related: null });
  markPublishing(db, 6);
  markNeedsReview(db, 6, '2026-09-26T12:04:00.000Z');
  markFailed(db, 7, { error: 'bad response', processedAt: '2026-09-26T12:05:00.000Z' });
  markDone(db, 8, { verdict: 'duplicate_closed', issueNumber: 99, processedAt: '2026-09-26T11:59:59.999Z', related: null });
  expect(summarizeSince(db, '2026-09-26T12:00:00.000Z')).toEqual({
    processed: 6,
    byVerdict: { new: 1, duplicate_open: 1, duplicate_closed: 1, not_a_bug: 1 },
    queued: 1, needsReview: [6], failed: [7], closedLinks: [{ reportId: 3, issueNumber: 92 }],
  });
});

test('summarizeSince returns zero counts and empty lists on an empty store', () => {
  expect(summarizeSince(db, '2026-09-26T12:00:00.000Z')).toEqual({
    processed: 0,
    byVerdict: { new: 0, duplicate_open: 0, duplicate_closed: 0, not_a_bug: 0 },
    queued: 0, needsReview: [], failed: [], closedLinks: [],
  });
});

test('listMedia orders by idx and markMediaPruned records the timestamp', () => {
  const id = insertReport(db, report);
  addMedia(db, { reportId: id, idx: 2, kind: 'video', path: '/reports/1/2.mp4', bytes: 20 });
  addMedia(db, { reportId: id, idx: 1, kind: 'photo', path: '/reports/1/1.jpg', bytes: 10 });
  markMediaPruned(db, id, 2, '2027-03-01T00:00:00.000Z');
  expect(listMedia(db, id)).toEqual([
    { reportId: 1, idx: 1, kind: 'photo', path: '/reports/1/1.jpg', bytes: 10, prunedAt: null },
    { reportId: 1, idx: 2, kind: 'video', path: '/reports/1/2.mp4', bytes: 20, prunedAt: '2027-03-01T00:00:00.000Z' },
  ]);
});

test('listPrunableMedia excludes failed, pruned, and boundary-date media', () => {
  insertReport(db, { ...report, createdAt: '2026-09-25T23:59:59.999Z' });
  insertReport(db, { ...report, createdAt: '2026-09-26T00:00:00.000Z' });
  addMedia(db, { reportId: 1, idx: 1, kind: 'photo', path: '/keep/1.jpg', bytes: 10 });
  addMedia(db, { reportId: 1, idx: 2, kind: 'photo', path: '/failed/2.jpg', bytes: 0 });
  addMedia(db, { reportId: 1, idx: 3, kind: 'video', path: '/pruned/3.mp4', bytes: 20 });
  addMedia(db, { reportId: 2, idx: 1, kind: 'photo', path: '/boundary/1.jpg', bytes: 10 });
  markMediaPruned(db, 1, 3, '2027-03-01T00:00:00.000Z');
  expect(listPrunableMedia(db, '2026-09-26T00:00:00.000Z')).toEqual([
    { reportId: 1, idx: 1, kind: 'photo', path: '/keep/1.jpg', bytes: 10, prunedAt: null },
  ]);
});

test('deleting a report cascades to its media', () => {
  const id = insertReport(db, report);
  addMedia(db, { reportId: id, idx: 0, kind: 'photo', path: '/reports/1/0.jpg', bytes: 10 });
  db.prepare('DELETE FROM bug_reports WHERE id = ?').run(id);
  expect(listMedia(db, id)).toEqual([]);
});

test('bugReportStore exposes the named storage operations', () => {
  const id = bugReportStore.insertReport(db, report);
  expect(bugReportStore.getReport(db, id)?.text).toBe('The badge is missing on this beer');
});
