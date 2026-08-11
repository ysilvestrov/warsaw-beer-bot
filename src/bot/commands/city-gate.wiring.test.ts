import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Composer, Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUserCity } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import type { BotContext } from '../index';
import { cityGate } from './city-gate';

// The single highest-consequence property of #399: cityGate MUST run before the
// gated commands' own composers, because those composers never call next() once
// they've handled the update — if the gate sits downstream of them, it simply
// never runs and every city-scoped command silently opens up for everyone. A
// reviewer moved cityGate from first to last inside src/index.ts's `bot.use(...)`
// and all 1848 tests still passed, so that invariant had no coverage at all.
// This file closes the gap with two complementary tests:
//   (a) a real-Telegraf integration test (below) that proves registration order
//       controls whether the gate actually runs;
//   (b) a source-level guard (bottom of the file) that pins the ACTUAL order in
//       src/index.ts, since (a) builds its own bot and can't see a real reorder.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'B',
  username: 'BeerBot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

// A synthetic `/command` update carrying just enough of the Telegram shape for
// Telegraf's command filter (message.text + a leading bot_command entity) and
// for cityGateHandler (message.from).
function commandUpdate(updateId: number, command: string, userId: number) {
  const text = `/${command}`;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private' as const, first_name: 'Test' },
      from: { id: userId, is_bot: false, first_name: 'Test' },
      text,
      entities: [{ type: 'bot_command' as const, offset: 0, length: text.length }],
    },
  };
}

// Builds a bot the same way src/index.ts wires it: cityGate registered first,
// then a handful of stand-in composers that just record whether they ran.
// `refresh` is registered LAST among the stand-ins to prove that a gated
// command's position relative to its SIBLING composers doesn't matter — only
// cityGate's position relative to all of them does.
function buildBot(db: ReturnType<typeof freshDb>) {
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;

  const replies: string[] = [];
  const ran: string[] = [];

  bot.use((ctx, next) => {
    ctx.deps = { db, env: {}, log: { warn() {}, error() {}, info() {} } } as never;
    ctx.t = createTranslator('en');
    ctx.reply = ((text: string) => {
      replies.push(text);
      return Promise.resolve({} as never);
    }) as never;
    return next();
  });

  const pubsStandin = new Composer<BotContext>();
  pubsStandin.command('pubs', async () => { ran.push('pubs'); });

  const statusStandin = new Composer<BotContext>();
  statusStandin.command('status', async () => { ran.push('status'); });

  const refreshStandin = new Composer<BotContext>();
  refreshStandin.command('refresh', async () => { ran.push('refresh'); });

  bot.use(cityGate, pubsStandin, statusStandin, refreshStandin);

  return { bot, replies, ran };
}

test('a user with a Polish city passes through to a gated command', async () => {
  const db = freshDb();
  ensureProfile(db, 1);
  setUserCity(db, 1, 'krakow');
  const { bot, replies, ran } = buildBot(db);

  await bot.handleUpdate(commandUpdate(1, 'pubs', 1) as unknown as Update);

  expect(ran).toEqual(['pubs']);
  expect(replies).toEqual([]);
});

test('a user outside Poland is blocked from a gated command', async () => {
  const db = freshDb();
  const { bot, replies, ran } = buildBot(db);

  await bot.handleUpdate(commandUpdate(2, 'pubs', 2) as unknown as Update);

  expect(ran).toEqual([]);
  expect(replies).toEqual([createTranslator('en')('city.blocked')]);
});

test('a gated command registered last is still gated (position among siblings does not matter)', async () => {
  const db = freshDb();
  const { bot, replies, ran } = buildBot(db);

  await bot.handleUpdate(commandUpdate(3, 'refresh', 3) as unknown as Update);

  expect(ran).toEqual([]);
  expect(replies).toEqual([createTranslator('en')('city.blocked')]);
});

test('a non-gated command still runs for a blocked user', async () => {
  const db = freshDb();
  const { bot, replies, ran } = buildBot(db);

  await bot.handleUpdate(commandUpdate(4, 'status', 4) as unknown as Update);

  expect(ran).toEqual(['status']);
  expect(replies).toEqual([]);
});

// (b) Source-level guard on the ACTUAL wiring. The integration tests above build
// their own bot from scratch, so they cannot observe someone reordering the real
// `bot.use(...)` call in src/index.ts. That invariant lives entirely in the
// composition root: a silent reorder there disables the whole city gate (as
// demonstrated above) and nothing else in the suite can detect it, so a
// source-level assertion is the only remaining way to pin it down.
test('the real bot.use(...) wiring in src/index.ts registers cityGate first', () => {
  const indexSrc = readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
  expect(indexSrc).toMatch(/bot\.use\(\s*cityGate,/);
});
