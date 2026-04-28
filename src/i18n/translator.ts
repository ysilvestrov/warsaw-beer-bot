import type { Locale, Messages, PluralForms, Translator } from './types';

function interpolate(tmpl: string, params?: Record<string, string | number>): string {
  if (!params) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : `{${k}}`,
  );
}

export function makeTranslatorFromDict(locale: Locale, dict: Messages): Translator {
  const pr = new Intl.PluralRules(locale);
  return (key, params) => {
    const raw = dict[key] as string | PluralForms;
    if (typeof raw === 'string') return interpolate(raw, params);
    // PluralForms — pivot завжди params.count (стандарт ICU/i18next).
    const count = params?.count;
    const form = typeof count === 'number' ? pr.select(count) : 'other';
    const tmpl = raw[form as keyof PluralForms] ?? raw.other;
    return interpolate(tmpl, params);
  };
}
