import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import type { DB } from '../../storage/db';
import { cityKeyboard } from '../keyboards';
import { ensureProfile, setUserCity, getUserCity } from '../../storage/user_profiles';
import { isKnownCity, cityLabel } from '../../domain/cities';

// Extracted for unit testing: store the slug only if it is a known city.
export function applyCitySelection(db: DB, telegramId: number, slug: string): boolean {
  if (!isKnownCity(slug)) return false;
  setUserCity(db, telegramId, slug);
  return true;
}

export const cityCommand = new Composer<BotContext>();

cityCommand.command('city', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const current = getUserCity(ctx.deps.db, ctx.from.id);
  await ctx.reply(ctx.t('city.prompt', { name: cityLabel(current) }), cityKeyboard(current));
});

cityCommand.action(/^city:([a-z-]+)$/, async (ctx) => {
  const slug = ctx.match[1];
  const telegramId = ctx.from!.id;
  ensureProfile(ctx.deps.db, telegramId);
  if (!applyCitySelection(ctx.deps.db, telegramId, slug)) {
    await ctx.answerCbQuery();
    return;
  }
  await ctx.editMessageText(ctx.t('city.changed', { name: cityLabel(slug) }));
  await ctx.answerCbQuery();
});
