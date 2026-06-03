import type { Telegraf } from 'telegraf';
import type pino from 'pino';
import type { BotContext } from './index';
import type { Locale } from '../i18n/types';
import { createTranslator } from '../i18n';
import { buildCommandMenu } from './commands/catalog';

const MENU_LOCALES: Locale[] = ['uk', 'pl', 'en'];
const DEFAULT_LOCALE: Locale = 'en'; // mirrors detectLocale's fallback

export async function registerCommandMenu(
  bot: Telegraf<BotContext>,
  log: pino.Logger,
): Promise<void> {
  try {
    for (const loc of MENU_LOCALES) {
      await bot.telegram.setMyCommands(buildCommandMenu(createTranslator(loc)), {
        language_code: loc,
      });
    }
    // Default scope for clients whose language isn't uk/pl/en.
    await bot.telegram.setMyCommands(buildCommandMenu(createTranslator(DEFAULT_LOCALE)));
    log.info('command menu registered');
  } catch (e) {
    log.warn({ err: e }, 'setMyCommands failed — native command menu not updated');
  }
}
