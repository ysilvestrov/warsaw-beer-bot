import { Telegraf, Context } from 'telegraf';
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Env } from '../config/env';

export interface AppDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
}

export interface BotContext extends Context {
  deps: AppDeps;
}

export function createBot(deps: AppDeps): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(deps.env.TELEGRAM_BOT_TOKEN);
  bot.use((ctx, next) => {
    ctx.deps = deps;
    return next();
  });
  bot.catch((err, ctx) => deps.log.error({ err, update: ctx.update }, 'bot error'));
  return bot;
}
