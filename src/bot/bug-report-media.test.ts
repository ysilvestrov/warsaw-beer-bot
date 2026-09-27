import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BugReportRow, ReportOutcome } from '../domain/bug-report-types';
import { createNotifier, downloadMedia, safeExt, writeReportMediaSync } from './bug-report-media';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'report-media-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('writeReportMediaSync writes the bytes under report ID and index', () => {
  const result = writeReportMediaSync({ dir, reportId: 12, idx: 1, ext: 'jpg', data: Buffer.from('data') });
  expect(result).toEqual({ path: join(dir, '12', '1.jpg'), bytes: 4 });
  expect(readFileSync(join(dir, '12', '1.jpg'), 'utf8')).toBe('data');
});

test('media is owner-only: directory 0700, file 0600', () => {
  writeReportMediaSync({ dir, reportId: 12, idx: 1, ext: 'jpg', data: Buffer.from('data') });
  expect(statSync(join(dir, '12')).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, '12', '1.jpg')).mode & 0o777).toBe(0o600);
});

test('a write that fails after the file was opened leaves no untracked file behind', () => {
  mkdirSync(join(dir, '12'));
  symlinkSync('/dev/full', join(dir, '12', '1.jpg')); // open succeeds, write fails with ENOSPC
  const result = writeReportMediaSync({ dir, reportId: 12, idx: 1, ext: 'jpg', data: Buffer.from('data') });
  expect(result).toEqual({ path: join(dir, '12', '1.jpg'), bytes: 0 });
  expect(() => lstatSync(join(dir, '12', '1.jpg'))).toThrow(/ENOENT/);
});

test('writeReportMediaSync records zero bytes and writes nothing for a failed download', () => {
  const result = writeReportMediaSync({ dir, reportId: 12, idx: 1, ext: 'jpg', data: null });
  expect(result).toEqual({ path: join(dir, '12', '1.jpg'), bytes: 0 });
  expect(existsSync(join(dir, '12'))).toBe(false);
});

test('writeReportMediaSync records zero bytes when the directory cannot be created', async () => {
  const blocked = join(dir, 'blocked');
  await writeFile(blocked, 'not a directory');
  const result = writeReportMediaSync({ dir: blocked, reportId: 12, idx: 1, ext: 'jpg', data: Buffer.from('data') });
  expect(result).toEqual({ path: join(blocked, '12', '1.jpg'), bytes: 0 });
});

test('a client-supplied traversal extension cannot leave the report directory', () => {
  const result = writeReportMediaSync({ dir, reportId: 12, idx: 0, ext: '../../evil', data: Buffer.from('x') });
  expect(result).toEqual({ path: join(dir, '12', '0.bin'), bytes: 1 });
  expect(existsSync(join(dir, '..', 'evil'))).toBe(false);
});

test.each([['png', 'png'], ['jpg', 'jpg'], ['webp', 'webp'], ['svg+xml', 'bin'], ['../x', 'bin'], ['', 'bin'], ['abcdefghi', 'bin']])(
  'safeExt(%s) is %s', (ext, expected) => { expect(safeExt(ext)).toBe(expected); },
);

test('downloadMedia returns null when Telegram download fails', async () => {
  expect(await downloadMedia('id', async () => { throw new Error('Telegram unavailable'); })).toBeNull();
  expect(await downloadMedia('id', async () => Buffer.from('ok'))).toEqual(Buffer.from('ok'));
});

const report: BugReportRow = {
  id: 7, telegramId: 101, chatId: 202, statusMessageId: 303, locale: 'en', city: 'warszawa',
  source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown', createdAt: '2026-09-27T12:00:00.000Z',
  status: 'done', attempts: 0, lastError: null, candidatesTruncated: false,
  deferredNotified: false, verdict: 'new', issueNumber: 42, processedAt: '2026-09-27T12:01:00.000Z',
};

test.each([
  [{ kind: 'created', issueNumber: 42 }, 'Thank you! Created issue: https://github.com/example/repo/issues/42'],
  [{ kind: 'duplicate_open', issueNumber: 43 }, 'Thank you! This is already known and open — your details were added: https://github.com/example/repo/issues/43'],
  [{ kind: 'duplicate_closed', issueNumber: 44, closedAt: '2026-09-20T12:00:00Z', fixed: true }, 'This was fixed on 2026-09-20. If you still see it after updating, report it again: https://github.com/example/repo/issues/44'],
  [{ kind: 'duplicate_closed', issueNumber: 45, closedAt: '2026-09-21T12:00:00Z', fixed: false }, 'This was already reported (closed on 2026-09-21): https://github.com/example/repo/issues/45'],
  [{ kind: 'not_a_bug' }, 'This does not look like a bug in the bot or extension.'],
  [{ kind: 'deferred' }, 'Received — I will respond later.'],
  [{ kind: 'needs_review' }, 'Received — a developer will review this manually.'],
  [{ kind: 'failed' }, 'The report could not be processed — a developer will look into it.'],
] as [ReportOutcome, string][])('createNotifier edits the status with exact text for %s', async (outcome, expected) => {
  const edits: unknown[][] = [];
  const notifier = createNotifier({ repo: 'example/repo', telegram: {
    editMessageText: async (...args: unknown[]) => { edits.push(args); return true as never; },
    sendMessage: async () => { throw new Error('send should not be used'); },
  } as never });
  await notifier(report, outcome);
  expect(edits).toEqual([[202, 303, undefined, expected]]);
});

test('createNotifier sends a new message when the status message ID is null', async () => {
  const sends: unknown[][] = [];
  const notifier = createNotifier({ repo: 'example/repo', telegram: {
    editMessageText: async () => { throw new Error('edit should not be used'); },
    sendMessage: async (...args: unknown[]) => { sends.push(args); return {} as never; },
  } as never });
  await notifier({ ...report, statusMessageId: null }, { kind: 'created', issueNumber: 42 });
  expect(sends).toEqual([[202, 'Thank you! Created issue: https://github.com/example/repo/issues/42']]);
});

test('createNotifier falls back to English for an unknown stored locale', async () => {
  const edits: unknown[][] = [];
  const notifier = createNotifier({ repo: 'example/repo', telegram: {
    editMessageText: async (...args: unknown[]) => { edits.push(args); return true as never; },
    sendMessage: async () => { throw new Error('send should not be used'); },
  } as never });
  await notifier({ ...report, locale: 'xx' }, { kind: 'not_a_bug' });
  expect(edits).toEqual([[202, 303, undefined, 'This does not look like a bug in the bot or extension.']]);
});

test('a refused edit (status message deleted) falls back to a new message', async () => {
  const sends: unknown[][] = [];
  const notifier = createNotifier({ repo: 'example/repo', telegram: {
    editMessageText: async () => { throw new Error('message to edit not found'); },
    sendMessage: async (...args: unknown[]) => { sends.push(args); return {} as never; },
  } as never });
  await notifier(report, { kind: 'not_a_bug' });
  expect(sends).toEqual([[202, 'This does not look like a bug in the bot or extension.']]);
});

test('when the fallback message also fails, the error propagates to the worker', async () => {
  const notifier = createNotifier({ repo: 'example/repo', telegram: {
    editMessageText: async () => { throw new Error('message to edit not found'); },
    sendMessage: async () => { throw new Error('bot was blocked by the user'); },
  } as never });
  await expect(notifier(report, { kind: 'not_a_bug' })).rejects.toThrow('bot was blocked by the user');
});
