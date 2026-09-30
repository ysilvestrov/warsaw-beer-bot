import { Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import { createTranslator } from '../../i18n';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { getFestBySlug } from '../../storage/fests';
import { addMember, createTeam } from '../../storage/fest_teams';
import { upsertMenuItem } from '../../storage/fest_menu';
import { queueFor } from '../../storage/fest_queue';
import type { BotContext } from '../index';
import { createFestCommand } from './fest';

const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};

function callback(updateId: number, from: number, data: string) {
  return { update_id: updateId, callback_query: { id: `cb-${updateId}`, chat_instance: 'x', data,
    from: { id: from, is_bot: false, first_name: 'Test' },
    message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup' as const, title: 'Team' } } } };
}

function setup(): { db: DB; bot: Telegraf<BotContext>; teamId: number; replies: string[]; answers: (string | undefined)[] } {
  const db = openDb(':memory:');
  migrate(db);
  const festId = getFestBySlug(db, 'wfp22')!.id;
  ensureProfile(db, 7);
  setUntappdUsername(db, 7, 'member');
  const teamId = createTeam(db, festId, -100, '2026-10-01T00:00:00.000Z').id;
  addMember(db, teamId, 7, 'YS', '2026-10-01T00:00:00.000Z');
  db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
              VALUES (11, 6000011, 'Bravo', 'Brew', 'bravo', 'brew')`).run();
  upsertMenuItem(db, festId, 11, 'PINTA', '2026-10-15T10:00:00.000Z');
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  const replies: string[] = [];
  const answers: (string | undefined)[] = [];
  bot.use((ctx, next) => {
    ctx.deps = { db, env: {}, log: {} } as never;
    ctx.locale = 'en';
    ctx.t = createTranslator('en');
    ctx.reply = (async (message: string) => { replies.push(message); return { message_id: 1 }; }) as never;
    ctx.answerCbQuery = (async (text?: string) => { answers.push(text); return true; }) as never;
    return next();
  });
  bot.use(createFestCommand({ downloadFile: async () => Buffer.from('') }));
  return { db, bot, teamId, replies, answers };
}

describe('«Взяв» (fest:q)', () => {
  it('a member gets a glass number, announced in the chat; a double tap gives the same glass', async () => {
    const { db, bot, teamId, replies } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:11`) as unknown as Update);
    await bot.handleUpdate(callback(2, 7, `fest:q:${teamId}:11`) as unknown as Update);
    expect(queueFor(db, teamId).map((r) => [r.glass_no, r.beer_id, r.added_by])).toEqual([[1, 11, 7]]);
    expect(replies).toEqual(['🍺 Glass #1 — Bravo · YS', '🍺 Glass #1 — Bravo · YS']);
  });

  it('someone outside the team queues nothing and is told so', async () => {
    const { db, bot, teamId, replies, answers } = setup();
    await bot.handleUpdate(callback(1, 8, `fest:q:${teamId}:11`) as unknown as Update);
    expect([queueFor(db, teamId), replies, answers]).toEqual([[], [], ['This is for team members — press “I’m in the team”.']]);
  });

  it('a beer that is not on the menu queues nothing', async () => {
    const { db, bot, teamId } = setup();
    await bot.handleUpdate(callback(1, 7, `fest:q:${teamId}:999`) as unknown as Update);
    expect(queueFor(db, teamId)).toEqual([]);
  });
});
