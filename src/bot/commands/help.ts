import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildHelpText } from './catalog';

export const helpCommand = new Composer<BotContext>();

helpCommand.command('help', async (ctx) => {
  await ctx.reply(buildHelpText(ctx.t));
});
