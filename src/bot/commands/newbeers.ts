import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildNewbeersMessage } from './newbeers-build';

export const newbeersCommand = new Composer<BotContext>();

newbeersCommand.command('newbeers', async (ctx) => {
  const text = buildNewbeersMessage({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    locale: ctx.locale,
    t: ctx.t,
  });
  await ctx.replyWithHTML(text ?? ctx.t('newbeers.empty'));
});
