import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../storage/db';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { addMedia, insertReport, listMedia } from '../storage/bug_reports';
import { pruneBugReportMedia } from './bug-report-prune';

const NOW = new Date('2026-09-27T00:00:00.000Z');
let db: DB;
let dir: string;

function addReportMedia(createdAt: string, path: string): number {
  const id = insertReport(db, {
    telegramId: 101, chatId: 202, statusMessageId: null, locale: 'uk', city: 'warszawa',
    source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown', createdAt,
  });
  addMedia(db, { reportId: id, idx: 0, kind: 'photo', path, bytes: 4 });
  return id;
}

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  dir = await mkdtemp(join(tmpdir(), 'bug-report-prune-'));
});
afterEach(async () => {
  db.close();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

test('a 181-day-old media file is removed and marked pruned', async () => {
  const path = join(dir, 'old.jpg');
  await writeFile(path, 'data');
  const id = addReportMedia('2026-03-30T00:00:00.000Z', path);
  expect(await pruneBugReportMedia({ db, now: NOW, unlink })).toBe(1);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(listMedia(db, id)).toEqual([{
    reportId: id, idx: 0, kind: 'photo', path, bytes: 4, prunedAt: '2026-09-27T00:00:00.000Z',
  }]);
});

test('media exactly at the 180-day cutoff is kept', async () => {
  const path = join(dir, 'boundary.jpg');
  await writeFile(path, 'data');
  const id = addReportMedia('2026-03-31T00:00:00.000Z', path);
  expect(await pruneBugReportMedia({ db, now: NOW, unlink })).toBe(0);
  expect(await readFile(path, 'utf8')).toBe('data');
  expect(listMedia(db, id)).toEqual([{
    reportId: id, idx: 0, kind: 'photo', path, bytes: 4, prunedAt: null,
  }]);
});

test('a missing old file is still marked pruned after ENOENT', async () => {
  const path = join(dir, 'missing.jpg');
  const id = addReportMedia('2026-03-30T00:00:00.000Z', path);
  expect(await pruneBugReportMedia({ db, now: NOW, unlink })).toBe(1);
  expect(listMedia(db, id)).toEqual([{
    reportId: id, idx: 0, kind: 'photo', path, bytes: 4, prunedAt: '2026-09-27T00:00:00.000Z',
  }]);
});

test('an EACCES unlink failure keeps the row unpruned', async () => {
  const path = join(dir, 'protected.jpg');
  await writeFile(path, 'data');
  const id = addReportMedia('2026-03-30T00:00:00.000Z', path);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const denied = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
  expect(await pruneBugReportMedia({ db, now: NOW, unlink: denied })).toBe(0);
  expect(await readFile(path, 'utf8')).toBe('data');
  expect(listMedia(db, id)).toEqual([{
    reportId: id, idx: 0, kind: 'photo', path, bytes: 4, prunedAt: null,
  }]);
});
