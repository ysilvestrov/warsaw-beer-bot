import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';
import { isKnownCity } from '../../domain/cities';
import { buildHelpText } from './catalog';

export const startCommand = new Composer<BotContext>();

startCommand.command('start', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const allowed = isKnownCity(getUserCity(ctx.deps.db, ctx.from.id));
  await ctx.reply(buildHelpText(ctx.t, allowed));
});
