import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildHelpText } from './catalog';
import { isKnownCity } from '../../domain/cities';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';

export const helpCommand = new Composer<BotContext>();

helpCommand.command('help', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const allowed = isKnownCity(getUserCity(ctx.deps.db, ctx.from.id));
  await ctx.reply(buildHelpText(ctx.t, allowed));
});
