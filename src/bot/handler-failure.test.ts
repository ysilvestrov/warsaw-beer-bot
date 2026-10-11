import { describe, expect, it } from 'vitest';
import { Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import type { AppDeps, BotContext } from './index';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { createTranslator } from '../i18n';
import { noteFailure, onHandlerFailure } from './handler-failure';

const NOW = new Date('2026-10-11T10:00:00.000Z');
const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};
const message = (text: string): Update => ({
  update_id: 1,
  message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, from: { id: 7, is_bot: false, first_name: 'U' }, text },
}) as unknown as Update;

function setup(opts: { fail: unknown; replyRejects?: boolean; locale?: 'uk' | 'pl' | 'en' | null } = { fail: new Error('boom') }) {
  const db = openDb(':memory:');
  migrate(db);
  const logged: { level: string; msg: string }[] = [];
  const log = {
    error: (_o: unknown, msg: string) => { logged.push({ level: 'error', msg }); },
    warn: (_o: unknown, msg: string) => { logged.push({ level: 'warn', msg }); },
  };
  const deps = { db, env: {}, log } as unknown as AppDeps;
  const replies: string[] = [];
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  bot.use((ctx, next) => {
    ctx.deps = deps;
    const locale = opts.locale === undefined ? 'uk' : opts.locale;
    if (locale !== null) { ctx.locale = locale; ctx.t = createTranslator(locale); }
    ctx.reply = (opts.replyRejects
      ? async () => { throw new Error('403: bot was blocked by the user'); }
      : async (m: string) => { replies.push(m); return { message_id: 9 }; }) as never;
    return next();
  });
  bot.on('message', () => { throw opts.fail; });
  bot.catch((err, ctx) => onHandlerFailure(deps, err, ctx, NOW));
  const rows = () => db.prepare('SELECT at, source, error FROM handler_failures ORDER BY id').all();
  return { bot, db, deps, replies, logged, rows };
}

describe('onHandlerFailure', () => {
  it('answers the person in their locale and records what failed', async () => {
    const s = setup({ fail: new Error('400: Bad Request: message is too long') });
    await s.bot.handleUpdate(message('/beers piw paw'));
    expect(s.replies).toEqual(['Не вдалося виконати команду. Спробуйте пізніше.']);
    expect(s.rows()).toEqual([
      { at: '2026-10-11T10:00:00.000Z', source: '/beers', error: '400: Bad Request: message is too long' },
    ]);
    expect(s.logged).toEqual([{ level: 'error', msg: 'bot error' }]);
  });

  it('uses the Polish text for a Polish locale', async () => {
    const s = setup({ fail: new Error('boom'), locale: 'pl' });
    await s.bot.handleUpdate(message('/pubs'));
    expect(s.replies).toEqual(['Nie udało się wykonać polecenia. Spróbuj później.']);
  });

  it('falls back to English when the i18n middleware never ran', async () => {
    const s = setup({ fail: new Error('boom'), locale: null });
    await s.bot.handleUpdate(message('/pubs'));
    expect(s.replies).toEqual(['The command failed. Please try again later.']);
  });

  it('a thrown non-Error is recorded as its string form', async () => {
    const s = setup({ fail: 'plain string' });
    await s.bot.handleUpdate(message('hello'));
    expect(s.rows()).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: 'text', error: 'plain string' }]);
  });

  it('a handler timeout is recorded but the person is not told it failed', async () => {
    const timeout = Object.assign(new Error('Promise timed out after 90000 milliseconds'), { name: 'TimeoutError' });
    const s = setup({ fail: timeout });
    await s.bot.handleUpdate(message('/route'));
    expect(s.replies).toEqual([]);
    expect(s.rows()).toEqual([
      { at: '2026-10-11T10:00:00.000Z', source: '/route', error: 'Promise timed out after 90000 milliseconds' },
    ]);
  });

  it('a reply that fails is logged as a warning and does not throw', async () => {
    const s = setup({ fail: new Error('boom'), replyRejects: true });
    await expect(s.bot.handleUpdate(message('/pubs'))).resolves.toBeUndefined();
    expect(s.logged).toEqual([
      { level: 'error', msg: 'bot error' },
      { level: 'warn', msg: 'handler failure reply not sent' },
    ]);
    expect(s.rows()).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: '/pubs', error: 'boom' }]);
  });

  it('an update without a chat is recorded and nothing is sent', async () => {
    const s = setup({ fail: new Error('boom') });
    const ctx = { update: { update_id: 1, poll: {} }, chat: undefined, t: createTranslator('uk') } as unknown as BotContext;
    await onHandlerFailure(s.deps, new Error('boom'), ctx, NOW);
    expect(s.replies).toEqual([]);
    expect(s.rows()).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: 'poll', error: 'boom' }]);
  });

  it('a failing INSERT does not stop the answer', async () => {
    const s = setup({ fail: new Error('boom') });
    s.db.exec('DROP TABLE handler_failures');
    await s.bot.handleUpdate(message('/pubs'));
    expect(s.replies).toEqual(['Не вдалося виконати команду. Спробуйте пізніше.']);
    expect(s.logged).toEqual([
      { level: 'error', msg: 'bot error' },
      { level: 'error', msg: 'handler failure not recorded' },
    ]);
  });
});

describe('noteFailure', () => {
  it('writes one row with the given source', () => {
    const s = setup({ fail: new Error('unused') });
    noteFailure(s.deps, '/route', new Error('fetch failed'), NOW);
    expect(s.rows()).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: '/route', error: 'fetch failed' }]);
  });
});
