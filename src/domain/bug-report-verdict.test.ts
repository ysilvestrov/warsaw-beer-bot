import { expect, test } from 'vitest';
import type { IssueDetail, RawVerdict } from './bug-report-types';
import { validateVerdict } from './bug-report-verdict';

const openIssue: IssueDetail = {
  number: 12, title: 'Known issue', state: 'open', labels: ['bug'],
  createdAt: '2026-01-01T00:00:00Z', closedAt: null, body: 'Existing report',
  stateReason: null, comments: [],
};
const closedIssue: IssueDetail = {
  ...openIssue, number: 13, state: 'closed', closedAt: '2026-01-02T00:00:00Z',
  stateReason: 'completed',
};
const raw: RawVerdict = {
  verdict: 'new', issueNumber: null, labels: [], severity: 'Severity-2', effort: 'effort/S',
  title: ' A title ', summary: 'Call +48 123 456 789', where: '', subjects: [],
  expected: '', actual: '', steps: [], screenEvidence: [], newEvidence: '',
};
const fields = {
  title: 'A title', summary: 'Call [приховано]', where: '', subjects: [],
  expected: '', actual: '', steps: [], screenEvidence: [], newEvidence: '',
};

test('rejects an unknown verdict first', () => {
  expect(validateVerdict({ ...raw, verdict: 'else' as RawVerdict['verdict'], issueNumber: 999 }, [], 'bot'))
    .toEqual({ ok: false, reason: 'Unknown verdict.' });
});

test('rejects a new verdict with an issue number', () => {
  expect(validateVerdict({ ...raw, issueNumber: 12 }, [openIssue], 'bot'))
    .toEqual({ ok: false, reason: 'Issue number must match duplicate verdict.' });
});

test('rejects a duplicate without an issue number', () => {
  expect(validateVerdict({ ...raw, verdict: 'duplicate_open' }, [openIssue], 'bot'))
    .toEqual({ ok: false, reason: 'Issue number must match duplicate verdict.' });
});

test('rejects a duplicate number outside the candidate list', () => {
  expect(validateVerdict({ ...raw, verdict: 'duplicate_open', issueNumber: 999 }, [openIssue], 'bot'))
    .toEqual({ ok: false, reason: 'Issue number is not a candidate.' });
});

test('rejects an open duplicate when GitHub says closed', () => {
  expect(validateVerdict({ ...raw, verdict: 'duplicate_open', issueNumber: 13 }, [closedIssue], 'bot'))
    .toEqual({ ok: false, reason: 'Candidate state does not match duplicate verdict.' });
});

test('rejects a closed duplicate when GitHub says open', () => {
  expect(validateVerdict({ ...raw, verdict: 'duplicate_closed', issueNumber: 12 }, [openIssue], 'bot'))
    .toEqual({ ok: false, reason: 'Candidate state does not match duplicate verdict.' });
});

test('rejects invalid new severity', () => {
  expect(validateVerdict({ ...raw, severity: 'low' as RawVerdict['severity'] }, [], 'bot'))
    .toEqual({ ok: false, reason: 'Invalid severity.' });
});

test('rejects invalid new effort', () => {
  expect(validateVerdict({ ...raw, effort: 'effort/XL' as RawVerdict['effort'] }, [], 'bot'))
    .toEqual({ ok: false, reason: 'Invalid effort.' });
});

test('rejects a title empty after trimming', () => {
  expect(validateVerdict({ ...raw, title: '  ' }, [], 'bot'))
    .toEqual({ ok: false, reason: 'New issue title is empty.' });
});

test('accepts a new issue with filtered area labels and redacted fields', () => {
  expect(validateVerdict({ ...raw, labels: ['matcher-bug', 'wontfix'] }, [], 'bot'))
    .toEqual({ ok: true, value: { kind: 'new', fields, labels: ['matcher-bug', 'user-report'], severity: 'Severity-2', effort: 'effort/S' } });
});

test('adds bug when a bot new issue has no valid area labels', () => {
  expect(validateVerdict(raw, [], 'bot')).toEqual({
    ok: true, value: { kind: 'new', fields, labels: ['bug', 'user-report'], severity: 'Severity-2', effort: 'effort/S' },
  });
});

test('adds extension-bug for extension new issues', () => {
  expect(validateVerdict(raw, [], 'extension')).toEqual({
    ok: true, value: { kind: 'new', fields, labels: ['extension-bug', 'user-report'], severity: 'Severity-2', effort: 'effort/S' },
  });
});

test('orders and deduplicates extension labels', () => {
  expect(validateVerdict({ ...raw, labels: ['extension-bug', 'bug', 'bug'] }, [], 'extension'))
    .toEqual({ ok: true, value: { kind: 'new', fields, labels: ['bug', 'extension-bug', 'user-report'], severity: 'Severity-2', effort: 'effort/S' } });
});

test('returns the original open candidate for a valid duplicate', () => {
  expect(validateVerdict({ ...raw, verdict: 'duplicate_open', issueNumber: 12 }, [openIssue], 'bot'))
    .toEqual({ ok: true, value: { kind: 'duplicate_open', issue: openIssue, fields } });
});

test('returns the original closed candidate for a valid duplicate', () => {
  expect(validateVerdict({ ...raw, verdict: 'duplicate_closed', issueNumber: 13 }, [closedIssue], 'bot'))
    .toEqual({ ok: true, value: { kind: 'duplicate_closed', issue: closedIssue, fields } });
});

test('accepts not_a_bug without issue fields', () => {
  expect(validateVerdict({ ...raw, verdict: 'not_a_bug' }, [], 'bot'))
    .toEqual({ ok: true, value: { kind: 'not_a_bug' } });
});
