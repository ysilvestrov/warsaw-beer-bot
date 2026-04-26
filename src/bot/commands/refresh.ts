import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import type { ProgressFn } from '../../jobs/progress';

const COOLDOWN_MS = 5 * 60 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 2000;
const lastCall = new Map<number, number>();

export function makeThrottledProgress(
  send: (text: string) => Promise<void>,
  intervalMs: number,
  now: () => number = Date.now,
): ProgressFn {
  let lastAt = 0;
  let lastText = '';
  return async (text, opts) => {
    if (text === lastText) return;
    if (!opts?.force && now() - lastAt < intervalMs) return;
    lastAt = now();
    lastText = text;
    await send(text);
  };
}

export function createRefreshCommand(run: (notify: ProgressFn) => Promise<void>) {
  const cmd = new Composer<BotContext>();
  cmd.command('refresh', async (ctx) => {
    const prev = lastCall.get(ctx.from.id) ?? 0;
    if (Date.now() - prev < COOLDOWN_MS) {
      await ctx.reply('⏱ Занадто часто — спробуй за кілька хвилин.');
      return;
    }
    lastCall.set(ctx.from.id, Date.now());

    const status = await ctx.reply('⏳ Оновлюю…');
    const notify = makeThrottledProgress(
      async (text) => {
        await ctx.telegram
          .editMessageText(ctx.chat.id, status.message_id, undefined, text)
          .catch(() => {});
      },
      PROGRESS_MIN_INTERVAL_MS,
    );

    try {
      await run(notify);
      await notify('✅ Готово.', { force: true });
    } catch (e) {
      ctx.deps.log.error({ err: e }, 'refresh failed');
      await notify('❌ Не вдалось — подивись логи.', { force: true });
    }
  });
  return cmd;
}
