import type { Telegram } from 'telegraf';
import { createTranslator } from '../i18n';
import type { Locale, Translator } from '../i18n/types';

interface Entry {
  chatId: number;
  messageId: number;
  locale: Locale;
  lastText: string;
}

const active = new Map<string, Entry>();
const key = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

export interface ProgressHandle {
  update(text: string): void;
  release(): void;
}

// Register an in-flight progress message so a graceful shutdown can mark it as
// interrupted instead of leaving it frozen forever.
export function trackProgress(chatId: number, messageId: number, locale: Locale): ProgressHandle {
  const k = key(chatId, messageId);
  active.set(k, { chatId, messageId, locale, lastText: '' });
  return {
    update(text: string): void {
      const e = active.get(k);
      if (e) e.lastText = text;
    },
    release(): void {
      active.delete(k);
    },
  };
}

// Best-effort: append an "interrupted by restart" notice to every still-active
// progress message, then clear the registry. Called from the shutdown path.
export async function interruptActiveProgress(
  telegram: Pick<Telegram, 'editMessageText'>,
  makeTranslator: (locale: Locale) => Translator = createTranslator,
): Promise<void> {
  const entries = [...active.values()];
  active.clear();
  for (const e of entries) {
    const suffix = makeTranslator(e.locale)('common.interrupted_by_restart');
    const text = e.lastText ? `${e.lastText}\n\n${suffix}` : suffix;
    await telegram.editMessageText(e.chatId, e.messageId, undefined, text).catch(() => {});
  }
}
