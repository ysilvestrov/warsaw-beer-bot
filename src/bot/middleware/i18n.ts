import type { Locale } from '../../i18n/types';
import { createTranslator, detectLocale } from '../../i18n';
import {
  ensureProfile,
  getUserLanguage,
  setUserLanguage,
} from '../../storage/user_profiles';

// Loose ctx type — Task 10 widens BotContext to include locale + t.
// We don't use MiddlewareFn<Ctx> here because Telegraf constrains the type
// parameter to Context<Update>; the plain function type is structurally
// compatible with MiddlewareFn<BotContext> once Task 10 lands.
type Ctx = {
  from?: { id: number; language_code?: string };
  deps: { db: import('../../storage/db').DB };
  locale?: Locale;
  t?: ReturnType<typeof createTranslator>;
};

export const i18nMiddleware = async (ctx: Ctx, next: () => Promise<void>): Promise<void> => {
  const db = ctx.deps.db;
  const userId = ctx.from?.id;

  let locale: Locale;
  if (userId !== undefined) {
    const stored = getUserLanguage(db, userId);
    if (stored) {
      locale = stored;
    } else {
      locale = detectLocale(ctx.from?.language_code);
      // Persist so subsequent updates skip the detection round-trip and
      // /lang in PR 2 has a row to update.
      ensureProfile(db, userId);
      setUserLanguage(db, userId, locale);
    }
  } else {
    locale = 'en';
  }

  ctx.locale = locale;
  ctx.t = createTranslator(locale);
  await next();
};
