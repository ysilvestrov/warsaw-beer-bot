import { expect, test } from 'vitest';
import type { Draft, DraftMedia, FlowEvent } from './bug-report-flow';
import { stepFlow } from './bug-report-flow';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const ISO = '2026-09-27T12:00:00.000Z';
const media: DraftMedia = { fileId: 'photo-1', kind: 'photo', fileSize: 1024, ext: 'jpg' };
const source: Draft = {
  step: 'source', source: null, category: null, text: null, media: [], updatedAt: '2026-09-27T11:59:00.000Z',
};
const category: Draft = { ...source, step: 'category', source: 'bot' };
const textDraft: Draft = { ...category, step: 'text', category: 'wrong_beer' };
const mediaDraft: Draft = { ...textDraft, step: 'media', text: '1234567890' };
const confirm: Draft = { ...mediaDraft, step: 'confirm', media: [media] };
const start: FlowEvent = {
  type: 'start', submittedToday: 2, banned: false, available: true, privateChat: true,
};

test('start replaces a live draft and asks for a source below the daily limit', () => {
  expect(stepFlow(confirm, start, NOW)).toEqual({
    draft: { step: 'source', source: null, category: null, text: null, media: [], updatedAt: ISO },
    replies: [{ key: 'report.ask_source', keyboard: { kind: 'sources' } }], passThrough: false,
  });
});

test.each([
  [{ ...start, privateChat: false, available: false, banned: true, submittedToday: 3 }, 'report.private_only'],
  [{ ...start, available: false, banned: true, submittedToday: 3 }, 'report.unavailable'],
  [{ ...start, banned: true, submittedToday: 3 }, 'report.banned'],
  [{ ...start, submittedToday: 3 }, 'report.limit'],
] as const)('start checks admission in order: %s', (event, key) => {
  expect(stepFlow(confirm, event, NOW)).toEqual({ draft: null, replies: [{ key }], passThrough: false });
});

test('cancel deletes a live draft', () => {
  expect(stepFlow(category, { type: 'cancel' }, NOW)).toEqual({
    draft: null, replies: [{ key: 'report.cancelled' }], passThrough: false,
  });
});

test.each([
  { type: 'pick_source', source: 'bot' },
  { type: 'pick_category', category: 'other' },
  { type: 'media_done' },
  { type: 'submit', submittedToday: 0 },
] as FlowEvent[])(
  '$type on a missing draft reports expiry', (event) => {
    expect(stepFlow(null, event, NOW)).toEqual({
      draft: null, replies: [{ key: 'report.expired' }], passThrough: false,
    });
  },
);

test.each([
  { type: 'text', text: 'hello' },
  { type: 'media', media },
  { type: 'cancel' },
] as FlowEvent[])('a missing draft passes through %s', (event) => {
  expect(stepFlow(null, event, NOW)).toEqual({ draft: null, replies: [], passThrough: true });
});

test('a draft exactly 30 minutes old accepts a source', () => {
  expect(stepFlow({ ...source, updatedAt: '2026-09-27T11:30:00.000Z' },
    { type: 'pick_source', source: 'extension' }, NOW)).toEqual({
    draft: { step: 'category', source: 'extension', category: null, text: null, media: [], updatedAt: ISO },
    replies: [{ key: 'report.ask_category', keyboard: { kind: 'categories', source: 'extension' } }],
    passThrough: false,
  });
});

test('a draft 30 minutes and one millisecond old expires before a button press', () => {
  expect(stepFlow({ ...source, updatedAt: '2026-09-27T11:29:59.999Z' },
    { type: 'pick_source', source: 'bot' }, NOW)).toEqual({
    draft: null, replies: [{ key: 'report.expired' }], passThrough: false,
  });
});

test('a late text expires the draft and passes through', () => {
  expect(stepFlow({ ...textDraft, updatedAt: '2026-09-27T11:29:59.999Z' },
    { type: 'text', text: '1234567890' }, NOW)).toEqual({ draft: null, replies: [], passThrough: true });
});

test('pick_source at another step is ignored but refreshes the live draft', () => {
  expect(stepFlow(textDraft, { type: 'pick_source', source: 'extension' }, NOW)).toEqual({
    draft: { ...textDraft, updatedAt: ISO }, replies: [], passThrough: false,
  });
});

test('pick_category accepts a category for the selected source', () => {
  expect(stepFlow(category, { type: 'pick_category', category: 'route' }, NOW)).toEqual({
    draft: { ...category, step: 'text', category: 'route', updatedAt: ISO },
    replies: [{ key: 'report.ask_text' }], passThrough: false,
  });
});

test('a bot draft rejects extension-only no_badge', () => {
  expect(stepFlow(category, { type: 'pick_category', category: 'no_badge' }, NOW)).toEqual({
    draft: { ...category, updatedAt: ISO }, replies: [], passThrough: false,
  });
});

test('pick_category outside the category step is ignored', () => {
  expect(stepFlow(textDraft, { type: 'pick_category', category: 'other' }, NOW)).toEqual({
    draft: { ...textDraft, updatedAt: ISO }, replies: [], passThrough: false,
  });
});

test('/newbeers at the text step passes through without changing the draft fields', () => {
  expect(stepFlow(textDraft, { type: 'text', text: '/newbeers' }, NOW)).toEqual({
    draft: { ...textDraft, updatedAt: ISO }, replies: [], passThrough: true,
  });
});

test('text at a different step passes through', () => {
  expect(stepFlow(mediaDraft, { type: 'text', text: 'another description' }, NOW)).toEqual({
    draft: { ...mediaDraft, updatedAt: ISO }, replies: [], passThrough: true,
  });
});

test('nine trimmed characters are too short', () => {
  expect(stepFlow(textDraft, { type: 'text', text: '  123456789  ' }, NOW)).toEqual({
    draft: { ...textDraft, updatedAt: ISO }, replies: [{ key: 'report.too_short' }], passThrough: false,
  });
});

test('ten trimmed characters move to media', () => {
  expect(stepFlow(textDraft, { type: 'text', text: '  1234567890  ' }, NOW)).toEqual({
    draft: { ...textDraft, step: 'media', text: '1234567890', updatedAt: ISO },
    replies: [{ key: 'report.ask_media', keyboard: { kind: 'media' } }], passThrough: false,
  });
});

test('media at a different step passes through', () => {
  expect(stepFlow(textDraft, { type: 'media', media }, NOW)).toEqual({
    draft: { ...textDraft, updatedAt: ISO }, replies: [], passThrough: true,
  });
});

test('a file exactly 20 MiB is accepted', () => {
  const maxFile: DraftMedia = { fileId: 'max', kind: 'video', fileSize: 20 * 1024 * 1024, ext: 'mp4' };
  expect(stepFlow(mediaDraft, { type: 'media', media: maxFile }, NOW)).toEqual({
    draft: { ...mediaDraft, media: [maxFile], updatedAt: ISO },
    replies: [{ key: 'report.media_added', params: { n: 1, max: 3 } }], passThrough: false,
  });
});

test('a file one byte above 20 MiB is rejected', () => {
  expect(stepFlow(mediaDraft, { type: 'media', media: { ...media, fileSize: 20 * 1024 * 1024 + 1 } }, NOW))
    .toEqual({ draft: { ...mediaDraft, updatedAt: ISO },
      replies: [{ key: 'report.media_too_big' }], passThrough: false });
});

test('a fourth media item is rejected', () => {
  const full = { ...mediaDraft, media: [media, media, media] };
  expect(stepFlow(full, { type: 'media', media }, NOW)).toEqual({
    draft: { ...full, updatedAt: ISO }, replies: [{ key: 'report.media_full' }], passThrough: false,
  });
});

test('media_done summarizes the draft with translation parameters', () => {
  expect(stepFlow({ ...mediaDraft, media: [media] }, { type: 'media_done' }, NOW)).toEqual({
    draft: { ...mediaDraft, step: 'confirm', media: [media], updatedAt: ISO },
    replies: [{ key: 'report.confirm', params: {
      source: { t: 'report.source.bot' }, category: { t: 'report.cat.wrong_beer' },
      text: '1234567890', media: 1,
    }, keyboard: { kind: 'confirm' } }], passThrough: false,
  });
});

test('media_done outside the media step is ignored', () => {
  expect(stepFlow(confirm, { type: 'media_done' }, NOW)).toEqual({
    draft: { ...confirm, updatedAt: ISO }, replies: [], passThrough: false,
  });
});

test('submit below the daily limit returns a submission without replies', () => {
  expect(stepFlow(confirm, { type: 'submit', submittedToday: 2 }, NOW)).toEqual({
    draft: null, replies: [], passThrough: false,
    submission: { source: 'bot', category: 'wrong_beer', text: '1234567890', media: [media] },
  });
});

test('submit rechecks the daily limit and deletes the draft at three reports', () => {
  expect(stepFlow(confirm, { type: 'submit', submittedToday: 3 }, NOW)).toEqual({
    draft: null, replies: [{ key: 'report.limit' }], passThrough: false,
  });
});

test('submit outside the confirm step is ignored', () => {
  expect(stepFlow(mediaDraft, { type: 'submit', submittedToday: 0 }, NOW)).toEqual({
    draft: { ...mediaDraft, updatedAt: ISO }, replies: [], passThrough: false,
  });
});
