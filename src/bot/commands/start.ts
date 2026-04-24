import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile } from '../../storage/user_profiles';

export const startCommand = new Composer<BotContext>();

startCommand.command('start', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  await ctx.reply(
    [
      'Привіт! Я допоможу зібрати маршрут по варшавських пабах і випити щось нове.',
      '',
      '1) /link <untappd-username> — щоб підтягувати твої чекіни.',
      '2) /import — завантаж CSV-експорт зі свого Untappd для повного бекфілу історії.',
      '3) /newbeers — топ непитих пив на поточних кранах.',
      '4) /route N — маршрут, що покриває ≥ N непитих пив із мінімальною пішою відстанню.',
    ].join('\n'),
  );
});
