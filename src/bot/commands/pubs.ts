import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildPubsMessage } from './pubs-build';
import { getUserCity } from '../../storage/user_profiles';

export const pubsCommand = new Composer<BotContext>();

pubsCommand.command('pubs', async (ctx) => {
  const text = buildPubsMessage({ db: ctx.deps.db, t: ctx.t, city: getUserCity(ctx.deps.db, ctx.from.id) });
  await ctx.replyWithHTML(text);
});
