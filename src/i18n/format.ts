import type { Locale } from './types';

const COMMA_LOCALES: Set<Locale> = new Set(['uk', 'pl']);
const KM_UNIT: Record<Locale, string> = { uk: 'км', pl: 'km', en: 'km' };

export function fmtAbv(locale: Locale, abv: number | null): string {
  if (abv === null) return '';
  const rounded = Math.round(abv * 10) / 10;
  if (Number.isInteger(rounded)) return `  ·  ${rounded}%`;
  const txt = `${rounded}`;
  return `  ·  ${COMMA_LOCALES.has(locale) ? txt.replace('.', ',') : txt}%`;
}

export function fmtKm(locale: Locale, meters: number): string {
  const km = (meters / 1000).toFixed(1);
  const txt = COMMA_LOCALES.has(locale) ? km.replace('.', ',') : km;
  return `${txt} ${KM_UNIT[locale]}`;
}
