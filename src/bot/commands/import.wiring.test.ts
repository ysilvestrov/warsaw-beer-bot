import { Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import { createTranslator } from '../../i18n';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { getFestBySlug } from '../../storage/fests';
import { addMember, createTeam } from '../../storage/fest_teams';
import { standsFor } from '../../storage/fest_stands';
import type { BotContext } from '../index';
import { importCommand } from './import';
import { createFestCommand } from './fest';

// A document goes to /import unless its caption is another command: /import is registered before
// /fest in src/index.ts, and the CSV of /fest stands came to /import and failed as an Untappd export.

const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};

const document = (fileName: string, caption?: string) => ({
  update_id: 1,
  message: {
    message_id: 1, date: 1, chat: { id: 7, type: 'private' as const, first_name: 'Test' },
    from: { id: 7, is_bot: false, first_name: 'Test' },
    document: { file_id: 'f1', file_unique_id: 'u1', file_name: fileName },
    ...(caption === undefined ? {} : { caption }),
  },
});

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  ensureProfile(db, 7);
  setUntappdUsername(db, 7, 'member');
  addMember(db, createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z').id, 7, 'YS', '2026-10-01T00:00:00.000Z');
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  const replies: string[] = [];
  bot.use((ctx, next) => {
    ctx.deps = { db, env: {}, log: {} } as never;
    ctx.locale = 'en';
    ctx.t = createTranslator('en');
    ctx.reply = (async (message: string) => { replies.push(message); return { message_id: 1 }; }) as never;
    return next();
  });
  // The production order (src/index.ts): /import before /fest.
  bot.use(importCommand, createFestCommand({
    downloadFile: async () => Buffer.from('section;floor;stand\nPINTA;2;B14\n'),
    printStationUrl: 'https://beer-api.example/fest-print',
  }));
  return { db, festId, bot, replies };
}

describe('documents with /import before /fest', () => {
  it('a CSV captioned /fest stands reaches /fest stands, not the Untappd import', async () => {
    const { db, festId, bot, replies } = setup();
    await bot.handleUpdate(document('wfp22-stands.csv', '/fest stands') as unknown as Update);
    expect([replies[0], [...standsFor(db, festId).values()]]).toEqual([
      'Stands saved: 1.\nNot in the menu (saved, not used yet): PINTA.',
      [{ section: 'PINTA', floor: '2', stand: 'B14' }],
    ]);
  });

  it('the same caption addressed to this bot by name reaches /fest stands too', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(document('wfp22-stands.csv', '/fest@BeerBot stands') as unknown as Update);
    expect(replies[0]).toBe('Stands saved: 1.\nNot in the menu (saved, not used yet): PINTA.');
  });

  it('a document without a caption is still an import', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(document('notes.txt') as unknown as Update);
    expect(replies).toEqual(['Unsupported format. Expected .csv, .json or .zip.']);
  });

  it('a document with a plain-text caption is still an import', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(document('notes.txt', 'my checkins') as unknown as Update);
    expect(replies).toEqual(['Unsupported format. Expected .csv, .json or .zip.']);
  });

  it('a document captioned /import is still an import', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(document('notes.txt', '/import') as unknown as Update);
    expect(replies).toEqual(['Unsupported format. Expected .csv, .json or .zip.']);
  });
});
