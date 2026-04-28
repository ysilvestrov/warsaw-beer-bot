import type { Locale } from './types';

export function detectLocale(code: string | undefined): Locale {
  const lang = (code ?? '').toLowerCase().split('-')[0];
  if (lang === 'uk') return 'uk';
  if (lang === 'pl') return 'pl';
  // 'be' / 'ru' / 'en' / unknown / undefined — англійська.
  // Особливо явно: ru → en (не нав'язуємо UA росіянам).
  // Коли в Phase 3 додамо 'be', тут зʼявиться ще одна гілка.
  return 'en';
}
