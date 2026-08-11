import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildHelpText } from './catalog';
import { hasCityScopedAccess } from '../city-access';
import { ensureProfile } from '../../storage/user_profiles';

export const helpCommand = new Composer<BotContext>();

helpCommand.command('help', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const allowed = hasCityScopedAccess(ctx.deps.db, ctx.from.id);
  await ctx.reply(buildHelpText(ctx.t, allowed));
});
