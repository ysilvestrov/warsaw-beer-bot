import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { langKeyboard } from '../keyboards';
import { ensureProfile, setUserLanguage } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import type { Locale } from '../../i18n/types';
import { LOCALE_NAMES } from '../../i18n/locale-names';

export const langCommand = new Composer<BotContext>();

langCommand.command('lang', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  await ctx.reply(ctx.t('lang.prompt'), langKeyboard());
});

langCommand.action(/^lang:(uk|pl|en)$/, async (ctx) => {
  const locale = ctx.match[1] as Locale;
  const telegramId = ctx.from!.id;

  ensureProfile(ctx.deps.db, telegramId);
  setUserLanguage(ctx.deps.db, telegramId, locale);

  const t = createTranslator(locale);
  const name = LOCALE_NAMES[locale];

  await ctx.editMessageText(t('lang.changed', { name }));
  await ctx.answerCbQuery();
});
