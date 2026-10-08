import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Composer, Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import { createTranslator } from '../../i18n';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { getDraft, saveDraft } from '../../storage/bug_report_drafts';
import type { BotContext } from '../index';
import { createReportCommand } from './report';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};

function documentUpdate(updateId: number, mime: string) {
  return { update_id: updateId, message: { message_id: updateId, date: 1,
    chat: { id: 101, type: 'private' as const, first_name: 'Test' },
    from: { id: 101, is_bot: false, first_name: 'Test', language_code: 'en' },
    document: { file_id: `file-${updateId}`, file_unique_id: `unique-${updateId}`,
      file_name: `file-${updateId}`, mime_type: mime, file_size: 10 } } };
}

function buildBot(reportFirst: boolean) {
  const db = openDb(':memory:');
  migrate(db);
  saveDraft(db, 101, { step: 'media', source: 'bot', category: 'wrong_beer',
    text: 'Wrong beer shown', media: [], updatedAt: NOW.toISOString() });
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  const imported: string[] = [];
  const replies: string[] = [];
  bot.use((ctx, next) => {
    ctx.deps = { db, env: {}, log: {} } as never;
    ctx.locale = 'en';
    ctx.t = createTranslator('en');
    ctx.reply = (async (message: string) => { replies.push(message); return { message_id: 1 }; }) as never;
    return next();
  });
  const report = createReportCommand({ available: true, mediaDir: '/tmp/unused', now: () => NOW,
    triggerWorker: () => {}, downloadFile: async () => Buffer.from('image') });
  const importedDocuments = new Composer<BotContext>();
  importedDocuments.on('document', (ctx) => { imported.push(ctx.message.document.file_id); });
  if (reportFirst) bot.use(report, importedDocuments);
  else bot.use(importedDocuments, report);
  return { db, bot, imported, replies };
}

test('report before import consumes image documents during a media draft and passes CSV through', async () => {
  const { db, bot, imported, replies } = buildBot(true);
  try {
    await bot.handleUpdate(documentUpdate(1, 'image/png') as unknown as Update);
    await bot.handleUpdate(documentUpdate(2, 'text/csv') as unknown as Update);
    expect(getDraft(db, 101)?.media).toEqual([
      { fileId: 'file-1', kind: 'photo', fileSize: 10, ext: 'png' },
    ]);
    expect(imported).toEqual(['file-2']);
    expect(replies).toEqual(['Added (1/3).']);
  } finally {
    db.close();
  }
});

test('import before report swallows the image document from an active media draft', async () => {
  const { db, bot, imported, replies } = buildBot(false);
  try {
    await bot.handleUpdate(documentUpdate(3, 'image/png') as unknown as Update);
    expect(getDraft(db, 101)?.media).toEqual([]);
    expect(imported).toEqual(['file-3']);
    expect(replies).toEqual([]);
  } finally {
    db.close();
  }
});

test('src/index.ts registers report after cityGate and before import inside bot.use', () => {
  const source = readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
  const wiring = source.match(/bot\.use\(([\s\S]*?)\n  \);/)?.[1];
  // #469: only the reboot composer (callback-only, rb:*) may sit between cityGate and report.
  expect(wiring).toMatch(/cityGate,\s*\/\/[^\n]*\n\s*createRebootCommand\(\{[\s\S]*?\n    \}\),\s*createReportCommand\(/);
  expect(wiring).toMatch(/createReportCommand\([\s\S]*?\),\s*startCommand,[\s\S]*?importCommand,/);
});
