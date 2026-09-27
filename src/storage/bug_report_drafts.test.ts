import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Draft } from '../domain/bug-report-flow';
import { openDb, type DB } from './db';
import { migrate } from './schema';
import { clearBan, deleteDraft, getDraft, isBanned, saveDraft, setBan } from './bug_report_drafts';

let db: DB;
const draft: Draft = {
  step: 'media', source: 'extension', category: 'no_badge', text: 'The badge is missing',
  media: [{ fileId: 'photo-123', kind: 'photo', fileSize: 2048, ext: 'png' }],
  updatedAt: '2026-09-27T12:00:00.000Z',
};

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => db.close());

test('getDraft returns null for a missing row', () => {
  expect(getDraft(db, 101)).toBeNull();
});

test('saveDraft round trips all fields including media', () => {
  saveDraft(db, 101, draft);
  expect(getDraft(db, 101)).toEqual({
    step: 'media', source: 'extension', category: 'no_badge', text: 'The badge is missing',
    media: [{ fileId: 'photo-123', kind: 'photo', fileSize: 2048, ext: 'png' }],
    updatedAt: '2026-09-27T12:00:00.000Z',
  });
  expect(db.prepare('SELECT media_json FROM bug_report_drafts WHERE telegram_id = 101').get())
    .toEqual({ media_json: '[{"fileId":"photo-123","kind":"photo","fileSize":2048,"ext":"png"}]' });
});

test('saveDraft upsert replaces the previous draft', () => {
  saveDraft(db, 101, draft);
  saveDraft(db, 101, {
    step: 'source', source: null, category: null, text: null, media: [],
    updatedAt: '2026-09-27T13:00:00.000Z',
  });
  expect(getDraft(db, 101)).toEqual({
    step: 'source', source: null, category: null, text: null, media: [],
    updatedAt: '2026-09-27T13:00:00.000Z',
  });
  expect(db.prepare('SELECT COUNT(*) AS n FROM bug_report_drafts WHERE telegram_id = 101').get())
    .toEqual({ n: 1 });
});

test('deleteDraft removes a saved draft', () => {
  saveDraft(db, 101, draft);
  deleteDraft(db, 101);
  expect(getDraft(db, 101)).toBeNull();
});

test('drafts are isolated by Telegram user', () => {
  saveDraft(db, 101, draft);
  saveDraft(db, 202, { ...draft, step: 'confirm', text: 'A different bug' });
  deleteDraft(db, 101);
  expect(getDraft(db, 101)).toBeNull();
  expect(getDraft(db, 202)).toEqual({
    step: 'confirm', source: 'extension', category: 'no_badge', text: 'A different bug',
    media: [{ fileId: 'photo-123', kind: 'photo', fileSize: 2048, ext: 'png' }],
    updatedAt: '2026-09-27T12:00:00.000Z',
  });
});

test('setBan and clearBan toggle the ban state', () => {
  expect(isBanned(db, 101)).toBe(false);
  setBan(db, 101, '2026-09-27T12:00:00.000Z');
  expect(isBanned(db, 101)).toBe(true);
  clearBan(db, 101);
  expect(isBanned(db, 101)).toBe(false);
});

test('setBan is idempotent and preserves the first ban timestamp', () => {
  setBan(db, 101, '2026-09-27T12:00:00.000Z');
  setBan(db, 101, '2026-09-27T13:00:00.000Z');
  expect(db.prepare('SELECT banned_at FROM bug_report_bans WHERE telegram_id = 101').get())
    .toEqual({ banned_at: '2026-09-27T12:00:00.000Z' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM bug_report_bans WHERE telegram_id = 101').get())
    .toEqual({ n: 1 });
});

test('banning one user does not ban another', () => {
  setBan(db, 101, '2026-09-27T12:00:00.000Z');
  expect(isBanned(db, 101)).toBe(true);
  expect(isBanned(db, 202)).toBe(false);
});
