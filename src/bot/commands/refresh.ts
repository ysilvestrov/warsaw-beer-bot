import { Composer } from 'telegraf';
import type { BotContext } from '../index';

const COOLDOWN_MS = 5 * 60 * 1000;
const lastCall = new Map<number, number>();

export function createRefreshCommand(run: () => Promise<void>) {
  const cmd = new Composer<BotContext>();
  cmd.command('refresh', async (ctx) => {
    const prev = lastCall.get(ctx.from.id) ?? 0;
    if (Date.now() - prev < COOLDOWN_MS) {
      await ctx.reply('⏱ Занадто часто — спробуй за кілька хвилин.');
      return;
    }
    lastCall.set(ctx.from.id, Date.now());
    await ctx.reply('Оновлюю…');
    try {
      await run();
      await ctx.reply('✅ Готово.');
    } catch (e) {
      ctx.deps.log.error({ err: e }, 'refresh failed');
      await ctx.reply('❌ Не вдалось — подивись логи.');
    }
  });
  return cmd;
}
