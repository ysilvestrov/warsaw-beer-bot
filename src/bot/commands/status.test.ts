import { Telegraf } from 'telegraf';
import type { BotContext } from '../index';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { seedBeer } from '../../storage/seed-beer.testing';
import { mergeCheckin } from '../../storage/checkins';
import { markHad } from '../../storage/untappd_had';
import { recordProfileTotal } from '../../storage/checkin_sync_state';
import { createTranslator } from '../../i18n';
import { statusCommand } from './status';

test('/status exposes the historical sync time and had-only evidence from its user’s DB rows', async () => {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  setUntappdUsername(db, 1, 'beerfan');
  const checked = seedBeer(db, { name: 'A', brewery: 'B', normalized_name: 'a', normalized_brewery: 'b' });
  const had = seedBeer(db, { name: 'C', brewery: 'B', normalized_name: 'c', normalized_brewery: 'b' });
  mergeCheckin(db, { telegram_id: 1, beer_id: checked, checkin_id: '1',
    user_rating: 4, checkin_at: '2026-09-03T20:40:22Z', venue: null });
  markHad(db, 1, had, '2026-09-28T03:00:00Z', 4.25);
  markHad(db, 2, checked, '2026-09-28T03:00:00Z', 3);
  recordProfileTotal(db, 1, 1);
  db.prepare('UPDATE checkin_sync_state SET updated_at = ? WHERE telegram_id = 1')
    .run('2026-09-03 22:19:05');

  const replies: string[] = [];
  const bot = new Telegraf<BotContext>('123:FAKE');
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Bot', username: 'BeerBot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
  bot.use((ctx, next) => {
    ctx.deps = { db } as never;
    ctx.t = createTranslator('en');
    ctx.replyWithHTML = async (html) => { replies.push(html); return {} as never; };
    return next();
  });
  bot.use(statusCommand);
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1,
    from: { id: 1, is_bot: false, first_name: 'Test' },
    chat: { id: 1, type: 'private', first_name: 'Test' }, text: '/status',
    entities: [{ type: 'bot_command', offset: 0, length: 7 }] } });
  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain('Check-ins synced: 1 / 1');
  expect(replies[0]).toContain('Last sync activity: 2026-09-03 22:19:05 UTC');
  expect(replies[0]).toContain('Beers known to the server without imported check-ins: 1.');
  expect(replies[0]).not.toContain('✅');
  db.close();
});
