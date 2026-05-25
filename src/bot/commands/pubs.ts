import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildPubsMessage } from './pubs-build';

export const pubsCommand = new Composer<BotContext>();

pubsCommand.command('pubs', async (ctx) => {
  const text = buildPubsMessage({ db: ctx.deps.db, t: ctx.t });
  await ctx.replyWithHTML(text);
});
