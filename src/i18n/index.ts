import type { Locale, Messages, Translator } from './types';
import { makeTranslatorFromDict } from './translator';
import { uk } from './locales/uk';
import { pl } from './locales/pl';
import { en } from './locales/en';

const LOCALES: Record<Locale, Messages> = { uk, pl, en };

export function createTranslator(locale: Locale): Translator {
  return makeTranslatorFromDict(locale, LOCALES[locale]);
}

export type { Locale, Messages, Translator } from './types';
export { detectLocale } from './detect-locale';
export { fmtAbv, fmtKm } from './format';
