import { expect, test } from 'vitest';
import type { Update, UserFromGetMe } from '@telegraf/types';
import { createBot, type AppDeps } from './index';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';

const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};

// #836, composition root: the failure handler is only worth something if createBot installs it.
// handler-failure.test.ts builds its own bot, so without this test createBot could go back to a
// bare log line and everything would stay green.
test('createBot: a handler that throws is answered and recorded', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const log = { error: () => {}, warn: () => {} };
  const bot = createBot({ db, env: { TELEGRAM_BOT_TOKEN: '123456:FAKE' }, log } as unknown as AppDeps);
  bot.botInfo = BOT_INFO;
  // Telegraf builds a fresh Telegram client per update, so the reply is captured on the context
  // prototype extension (bot.context is copied onto every ctx) rather than on bot.telegram.
  const replies: string[] = [];
  bot.context.reply = (async (text: string) => { replies.push(text); return { message_id: 9 }; }) as never;
  bot.command('pubs', () => { throw new Error('boom'); });

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1, date: 0, chat: { id: 5, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'U', language_code: 'uk' },
      text: '/pubs', entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  } as unknown as Update);

  expect(replies).toEqual(['Не вдалося виконати команду. Спробуйте пізніше.']);
  expect(db.prepare('SELECT source, error FROM handler_failures').all()).toEqual([{ source: '/pubs', error: 'boom' }]);
});
