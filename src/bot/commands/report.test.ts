import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Composer, Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import { createTranslator } from '../../i18n';
import type { Locale } from '../../i18n/types';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { getDraft, isBanned, saveDraft, setBan } from '../../storage/bug_report_drafts';
import { getReport, listMedia } from '../../storage/bug_reports';
import { ensureProfile, setUserCity } from '../../storage/user_profiles';
import type { BotContext } from '../index';
import { createReportCommand } from './report';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};
const person = (id: number) => ({ id, is_bot: false, first_name: 'Test', language_code: 'en' });
const chat = (id: number, type: 'private' | 'group') =>
  type === 'private' ? { id, type, first_name: 'Test' } : { id: -id, type, title: 'Group' };

function command(id: number, user: number, value: string, type: 'private' | 'group' = 'private') {
  return { update_id: id, message: { message_id: id, date: 1, chat: chat(user, type),
    from: person(user), text: value,
    entities: [{ type: 'bot_command', offset: 0, length: value.split(' ')[0].length }] } };
}
function textUpdate(id: number, user: number, value: string) {
  return { update_id: id, message: { message_id: id, date: 1, chat: chat(user, 'private'),
    from: person(user), text: value } };
}
function action(id: number, user: number, data: string, type: 'private' | 'group' = 'private') {
  return { update_id: id, callback_query: { id: String(id), from: person(user), chat_instance: 'test',
    data, message: { message_id: id, date: 1, chat: chat(user, type) } } };
}
function photoUpdate(id: number, user: number, type: 'private' | 'group' = 'private') {
  return { update_id: id, message: { message_id: id, date: 1, chat: chat(user, type),
    from: person(user), photo: [
      { file_id: 'small', file_unique_id: 'small-u', width: 50, height: 50, file_size: 5 },
      { file_id: 'large', file_unique_id: 'large-u', width: 500, height: 500, file_size: 11 },
    ] } };
}
function documentUpdate(id: number, user: number, mime: string, fileId: string) {
  return { update_id: id, message: { message_id: id, date: 1, chat: chat(user, 'private'),
    from: person(user), document: { file_id: fileId, file_unique_id: `${fileId}-u`,
      file_name: `${fileId}.bin`, mime_type: mime, file_size: 10 } } };
}
function videoUpdate(id: number, user: number) {
  return { update_id: id, message: { message_id: id, date: 1, chat: chat(user, 'private'),
    from: person(user), video: { file_id: 'video-id', file_unique_id: 'video-u', width: 300,
      height: 200, duration: 2, file_size: 10, mime_type: 'video/quicktime' } } };
}

let db: DB;
let mediaDir: string;
beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 101);
  setUserCity(db, 101, 'warszawa');
  mediaDir = await mkdtemp(join(tmpdir(), 'report-command-'));
});
afterEach(async () => { db.close(); await rm(mediaDir, { recursive: true, force: true }); });

function harness(locale: Locale = 'en', downloadFile = async (id: string) => Buffer.from(id),
  available = true, storageDir: string | null = mediaDir) {
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  const replies: { text: string; extra: unknown }[] = [];
  const downstream: string[] = [];
  let triggered = 0;
  let answered = 0;
  let messageId = 1000;
  bot.use((ctx, next) => {
    ctx.deps = { db, env: { ADMIN_TELEGRAM_ID: '999' }, log: {} } as never;
    ctx.locale = locale;
    ctx.t = createTranslator(locale);
    ctx.reply = (async (value: string, extra?: unknown) => {
      replies.push({ text: value, extra });
      return { message_id: ++messageId } as never;
    }) as never;
    ctx.answerCbQuery = (async () => { answered++; return true; }) as never;
    return next();
  });
  const probe = new Composer<BotContext>();
  probe.on('document', () => { downstream.push('document'); });
  probe.on('text', () => { downstream.push('text'); });
  probe.on('photo', () => { downstream.push('photo'); });
  bot.use(createReportCommand({ available, mediaDir: storageDir, now: () => NOW,
    triggerWorker: () => { triggered++; }, downloadFile }), probe);
  return { send: (update: object) => bot.handleUpdate(update as Update), replies, downstream,
    triggered: () => triggered, answered: () => answered };
}

test('full /report path stores one report and downloaded photo, then triggers the worker', async () => {
  const h = harness('pl');
  await h.send(command(1, 101, '/report'));
  await h.send(action(2, 101, 'report:src:extension'));
  await h.send(action(3, 101, 'report:cat:no_badge'));
  await h.send(textUpdate(4, 101, 'Badge missing on this beer'));
  await h.send(photoUpdate(5, 101));
  await h.send(action(6, 101, 'report:done'));
  await h.send(action(7, 101, 'report:send'));

  expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get()).toEqual({ n: 1 });
  expect(getReport(db, 1)).toMatchObject({
    id: 1, telegramId: 101, chatId: 101, statusMessageId: 1007, locale: 'pl',
    city: 'warszawa', source: 'extension', category: 'no_badge',
    text: 'Badge missing on this beer', createdAt: '2026-09-27T12:00:00.000Z', status: 'queued',
  });
  expect(listMedia(db, 1)).toEqual([{
    reportId: 1, idx: 0, kind: 'photo', path: join(mediaDir, '1', '0.jpg'), bytes: 5, prunedAt: null,
  }]);
  expect(await readFile(join(mediaDir, '1', '0.jpg'), 'utf8')).toBe('large');
  expect(h.triggered()).toBe(1);
  expect(getDraft(db, 101)).toBeNull();
  expect(h.replies[0]).toEqual({ text: 'Gdzie jest błąd?', extra: {
    reply_markup: { inline_keyboard: [[
      { text: 'Bot', callback_data: 'report:src:bot', hide: false },
      { text: 'Rozszerzenie', callback_data: 'report:src:extension', hide: false },
    ]] },
  } });
  const categoryRows = (h.replies[1].extra as { reply_markup: {
    inline_keyboard: { callback_data: string }[][];
  } }).reply_markup.inline_keyboard;
  expect(categoryRows.map((row) => row.map((button) => button.callback_data))).toEqual([
    ['report:cat:wrong_beer'], ['report:cat:no_rating'], ['report:cat:had_status'],
    ['report:cat:stale_data'], ['report:cat:no_badge'], ['report:cat:ext_broken'],
    ['report:cat:text_ui'], ['report:cat:other'],
  ]);
  expect(h.replies[3].extra).toEqual({ reply_markup: { inline_keyboard: [[
    { text: 'Gotowe', callback_data: 'report:done', hide: false },
    { text: 'Bez mediów', callback_data: 'report:done', hide: false },
  ]] } });
  expect(h.replies[4]).toEqual({ text: 'Dodano (1/3).', extra: undefined });
  expect(h.replies[5].text).toBe(
    'Sprawdź zgłoszenie:\nRozszerzenie · Brak oznaczenia na stronie sklepu\n\nBadge missing on this beer\n\nMedia: 1\n\nStreszczenie opisu zostanie opublikowane publicznie na GitHub. Zrzuty ekranu i filmy nie będą publiczne — zobaczą je tylko programiści na serwerze. Nie wpisuj danych osobowych w opisie.',
  );
  expect(h.replies[5].extra).toEqual({ reply_markup: { inline_keyboard: [[
    { text: 'Wyślij', callback_data: 'report:send', hide: false },
    { text: 'Anuluj', callback_data: 'report:cancel', hide: false },
  ]] } });
  expect(h.replies.at(-1)?.text).toBe('Przyjęto, analizuję…');
  expect(h.answered()).toBe(4);
});

test('a CSV document during media passes downstream without changing the draft', async () => {
  const h = harness();
  const draft = { step: 'media' as const, source: 'bot' as const, category: 'wrong_beer' as const,
    text: 'Wrong beer shown', media: [], updatedAt: '2026-09-27T11:59:00.000Z' };
  saveDraft(db, 101, draft);
  await h.send(documentUpdate(1, 101, 'text/csv', 'export'));
  expect(h.downstream).toEqual(['document']);
  expect(getDraft(db, 101)).toEqual(draft);
  expect(h.replies).toEqual([]);
});

test('/newbeers during the text step reaches the next composer', async () => {
  const h = harness();
  const draft = { step: 'text' as const, source: 'bot' as const, category: 'wrong_beer' as const,
    text: null, media: [], updatedAt: '2026-09-27T11:59:00.000Z' };
  saveDraft(db, 101, draft);
  await h.send(command(1, 101, '/newbeers'));
  expect(h.downstream).toEqual(['text']);
  expect(getDraft(db, 101)).toEqual(draft);
});

test('a send callback on an expired draft replies with expiry and inserts nothing', async () => {
  const h = harness();
  saveDraft(db, 101, { step: 'confirm', source: 'bot', category: 'wrong_beer',
    text: 'Wrong beer shown', media: [], updatedAt: '2026-09-27T11:29:59.999Z' });
  await h.send(action(1, 101, 'report:send'));
  expect(h.replies.map((r) => r.text)).toEqual(['This draft has expired — start again with /report']);
  expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get()).toEqual({ n: 0 });
  expect(h.answered()).toBe(1);
});

test('only /report replies in a group; a group photo passes downstream', async () => {
  const h = harness();
  await h.send(command(1, 101, '/report', 'group'));
  await h.send(photoUpdate(2, 101, 'group'));
  expect(h.replies.map((r) => r.text)).toEqual(['Reports are accepted only in a private chat with the bot.']);
  expect(h.downstream).toEqual(['photo']);
  expect(getDraft(db, 101)).toBeNull();
});

test('/reportban from the admin bans a user and a non-admin command passes downstream', async () => {
  const h = harness();
  await h.send(command(1, 999, '/reportban 123'));
  expect(isBanned(db, 123)).toBe(true);
  expect(h.replies.map((r) => r.text)).toEqual(['Reports disabled for 123.']);
  await h.send(command(2, 101, '/reportban 456'));
  expect(isBanned(db, 456)).toBe(false);
  expect(h.downstream).toEqual(['text']);
});

test('/reportban off clears a ban and malformed arguments show usage', async () => {
  const h = harness();
  await h.send(command(1, 999, '/reportban 123'));
  await h.send(command(2, 999, '/reportban 123 off'));
  await h.send(command(3, 999, '/reportban wrong'));
  expect(isBanned(db, 123)).toBe(false);
  expect(h.replies.map((r) => r.text)).toEqual([
    'Reports disabled for 123.', 'Reports enabled for 123.',
    'Usage: /reportban <telegram_id> [off]',
  ]);
});

test('a failed download still inserts the report and zero-byte media, then triggers work', async () => {
  const h = harness('en', async () => { throw new Error('Telegram download failed'); });
  saveDraft(db, 101, { step: 'confirm', source: 'bot', category: 'wrong_beer',
    text: 'Wrong beer shown', media: [{ fileId: 'gone', kind: 'photo', fileSize: 10, ext: 'jpg' }],
    updatedAt: '2026-09-27T11:59:00.000Z' });
  await h.send(action(1, 101, 'report:send'));
  expect(getReport(db, 1)?.status).toBe('queued');
  expect(listMedia(db, 1)).toEqual([{
    reportId: 1, idx: 0, kind: 'photo', path: join(mediaDir, '1', '0.jpg'), bytes: 0, prunedAt: null,
  }]);
  expect(h.triggered()).toBe(1);
});

test('a saved draft cannot submit while reports are unavailable after restart', async () => {
  const h = harness('en', async (id) => Buffer.from(id), false, null);
  saveDraft(db, 101, { step: 'confirm', source: 'bot', category: 'wrong_beer',
    text: 'Wrong beer shown', media: [{ fileId: 'saved', kind: 'photo', fileSize: 10, ext: 'jpg' }],
    updatedAt: '2026-09-27T11:59:00.000Z' });
  await h.send(action(1, 101, 'report:send'));
  expect(h.replies.map((r) => r.text)).toEqual(['Reports are temporarily unavailable.']);
  expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get()).toEqual({ n: 0 });
  expect(h.triggered()).toBe(0);
  expect(getDraft(db, 101)).toBeNull();
});

test('image documents and QuickTime videos are stored in the media draft', async () => {
  const h = harness();
  saveDraft(db, 101, { step: 'media', source: 'extension', category: 'no_badge',
    text: 'Missing badge', media: [], updatedAt: '2026-09-27T11:59:00.000Z' });
  await h.send(documentUpdate(1, 101, 'image/png', 'picture'));
  await h.send(videoUpdate(2, 101));
  expect(getDraft(db, 101)?.media).toEqual([
    { fileId: 'picture', kind: 'photo', fileSize: 10, ext: 'png' },
    { fileId: 'video-id', kind: 'video', fileSize: 10, ext: 'mov' },
  ]);
  expect(h.downstream).toEqual([]);
});

test('/cancel deletes a live draft', async () => {
  const h = harness();
  saveDraft(db, 101, { step: 'text', source: 'bot', category: 'wrong_beer',
    text: null, media: [], updatedAt: '2026-09-27T11:59:00.000Z' });
  await h.send(command(1, 101, '/cancel'));
  expect(getDraft(db, 101)).toBeNull();
  expect(h.replies.map((r) => r.text)).toEqual(['Report cancelled.']);
});

test('media is downloaded before the report row exists, so the worker never sees it half-built', async () => {
  const rowsAtDownload: unknown[] = [];
  const h = harness('en', async (id: string) => {
    rowsAtDownload.push(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get());
    return Buffer.from(id);
  });
  saveDraft(db, 101, { step: 'confirm', source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown',
    media: [{ fileId: 'a', kind: 'photo', fileSize: 1, ext: 'jpg' }, { fileId: 'b', kind: 'photo', fileSize: 1, ext: 'jpg' }],
    updatedAt: '2026-09-27T11:59:00.000Z' });
  await h.send(action(1, 101, 'report:send'));
  expect(rowsAtDownload).toEqual([{ n: 0 }, { n: 0 }]);
  expect(listMedia(db, 1).map((m) => m.bytes)).toEqual([1, 1]);
});

test('a group photo from a user with a live media draft passes downstream and leaves the draft', async () => {
  const h = harness();
  const draft = { step: 'media' as const, source: 'bot' as const, category: 'wrong_beer' as const,
    text: 'Wrong beer shown', media: [], updatedAt: '2026-09-27T11:59:00.000Z' };
  saveDraft(db, 101, draft);
  await h.send(photoUpdate(1, 101, 'group'));
  expect(h.downstream).toEqual(['photo']);
  expect(getDraft(db, 101)).toEqual(draft);
});

test('a double-tapped Send files exactly one report; the second press finds the draft claimed', async () => {
  const h = harness('en', async (id: string) => Buffer.from(id));
  saveDraft(db, 101, { step: 'confirm', source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown',
    media: [{ fileId: 'a', kind: 'photo', fileSize: 1, ext: 'jpg' }], updatedAt: '2026-09-27T11:59:00.000Z' });
  await Promise.all([h.send(action(1, 101, 'report:send')), h.send(action(2, 101, 'report:send'))]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get()).toEqual({ n: 1 });
  expect(h.triggered()).toBe(1);
  expect(h.replies.map((r) => r.text).sort()).toEqual([
    'Received, analyzing…', 'This draft has expired — start again with /report',
  ].sort());
});

test('a failure while recording media rolls back the report row too', async () => {
  const h = harness('en', async (id: string) => Buffer.from(id));
  db.exec(`CREATE TRIGGER fail_media BEFORE INSERT ON bug_report_media
    BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  saveDraft(db, 101, { step: 'confirm', source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown',
    media: [{ fileId: 'a', kind: 'photo', fileSize: 1, ext: 'jpg' }], updatedAt: '2026-09-27T11:59:00.000Z' });
  await h.send(action(1, 101, 'report:send')).catch(() => undefined);
  expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get()).toEqual({ n: 0 });
  expect(h.triggered()).toBe(0);
});

test('a user banned after opening the draft cannot submit it', async () => {
  const h = harness();
  saveDraft(db, 101, { step: 'confirm', source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown',
    media: [], updatedAt: '2026-09-27T11:59:00.000Z' });
  setBan(db, 101, '2026-09-27T11:59:30.000Z');
  await h.send(action(1, 101, 'report:send'));
  expect(h.replies.map((r) => r.text)).toEqual(['Reports are unavailable for you.']);
  expect(db.prepare('SELECT COUNT(*) AS n FROM bug_reports').get()).toEqual({ n: 0 });
  expect(h.triggered()).toBe(0);
});
