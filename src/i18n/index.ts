import type { Locale, Messages, Translator } from './types';
import { makeTranslatorFromDict } from './translator';
import { uk } from './locales/uk';

const LOCALES: Record<Locale, Messages> = {
  uk,
  // PR 2: pl, en (so far they share the uk dict to keep the type happy).
  pl: uk,
  en: uk,
};

export function createTranslator(locale: Locale): Translator {
  return makeTranslatorFromDict(locale, LOCALES[locale]);
}

export type { Locale, Messages, Translator } from './types';
export { detectLocale } from './detect-locale';
export { fmtAbv, fmtKm } from './format';
