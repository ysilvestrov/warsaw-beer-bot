import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildNewbeersMessage } from './newbeers-build';
import { getUserCity } from '../../storage/user_profiles';

export const newbeersCommand = new Composer<BotContext>();

newbeersCommand.command('newbeers', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const result = buildNewbeersMessage({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    locale: ctx.locale,
    t: ctx.t,
    pubQuery: arg || undefined,
    city: getUserCity(ctx.deps.db, ctx.from.id),
  });
  switch (result.kind) {
    case 'ok':
      await ctx.replyWithHTML(result.html);
      return;
    case 'empty':
      await ctx.reply(ctx.t('newbeers.empty'));
      return;
    case 'pub_not_found':
      await ctx.reply(ctx.t('newbeers.pub_not_found', { query: result.query }));
      return;
    default:
      // exhaustiveness: if NewbeersResult grows a new arm, TS errors here
      result satisfies never;
  }
});
