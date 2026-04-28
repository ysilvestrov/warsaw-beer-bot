import { Telegraf, Context } from 'telegraf';
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Env } from '../config/env';
import type { Locale, Translator } from '../i18n/types';
import { i18nMiddleware } from './middleware/i18n';

export interface AppDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
}

export interface BotContext extends Context {
  deps: AppDeps;
  locale: Locale;
  t: Translator;
}

export function createBot(deps: AppDeps): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(deps.env.TELEGRAM_BOT_TOKEN);
  bot.use((ctx, next) => {
    ctx.deps = deps;
    return next();
  });
  bot.use(i18nMiddleware);
  bot.catch((err, ctx) => deps.log.error({ err, update: ctx.update }, 'bot error'));
  return bot;
}
