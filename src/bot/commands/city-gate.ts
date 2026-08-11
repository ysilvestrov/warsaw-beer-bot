import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { COMMAND_CATALOG } from './catalog';
import { hasCityScopedAccess } from '../city-access';
import { ensureProfile } from '../../storage/user_profiles';

// Derived from the catalog so the gate and the /help filter can never disagree (#399).
export const CITY_SCOPED_COMMANDS: readonly string[] = COMMAND_CATALOG
  .filter((e) => e.cityScoped)
  .map((e) => e.command);

// A command update always carries `from` (Telegraf types it as `NonChannel`, where
// `from: User` is non-optional), so the handler can dereference `ctx.from.id`
// without a null check.
export type CommandCtx = BotContext & { from: NonNullable<BotContext['from']> };

// Blocks city-scoped commands for users who are "outside Poland" (or never picked a
// city). Passes everything else through by calling next().
export async function cityGateHandler(
  ctx: CommandCtx,
  next: () => Promise<void>,
): Promise<void> {
  ensureProfile(ctx.deps.db, ctx.from.id);
  if (hasCityScopedAccess(ctx.deps.db, ctx.from.id)) {
    await next();
    return;
  }
  await ctx.reply(ctx.t('city.blocked'));
}

export const cityGate = new Composer<BotContext>();

cityGate.command([...CITY_SCOPED_COMMANDS], (ctx, next) => cityGateHandler(ctx, next));
