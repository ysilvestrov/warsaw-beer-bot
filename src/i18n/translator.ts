import type { Locale, Messages, PluralForms, Translator } from './types';

function interpolate(tmpl: string, params?: Record<string, string | number>): string {
  if (!params) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : `{${k}}`,
  );
}

export function makeTranslatorFromDict(_locale: Locale, dict: Messages): Translator {
  return (key, params) => {
    const raw = dict[key] as string | PluralForms;
    if (typeof raw === 'string') return interpolate(raw, params);
    // Plural — implemented in Task 6.
    throw new Error(`PluralForms not yet supported for key: ${String(key)}`);
  };
}
