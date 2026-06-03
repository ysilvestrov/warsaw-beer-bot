import { Markup } from 'telegraf';
import type { Translator } from '../i18n/types';
import { ABV_PRESETS } from '../domain/filters';
import { OTHER_FAMILY } from '../domain/style-family';

export const langKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇦 Українська', 'lang:uk')],
    [Markup.button.callback('🇵🇱 Polski', 'lang:pl')],
    [Markup.button.callback('🇬🇧 English', 'lang:en')],
  ]);

export interface FiltersKeyboardState {
  families: string[];        // already ordered: top-N present ∪ active
  activeStyles: string[];
  abvKey: string | null;     // active ABV bucket key, or null
  minRating: number | null;  // active rating preset, or null
}

const RATING_PRESETS = [3.5, 3.8] as const;

export const filtersKeyboard = (t: Translator, state: FiltersKeyboardState) => {
  const activeLc = new Set(state.activeStyles.map((s) => s.toLowerCase()));

  const styleRows = [];
  for (let i = 0; i < state.families.length; i += 2) {
    const row = state.families.slice(i, i + 2).map((fam) => {
      const on = activeLc.has(fam.toLowerCase());
      const label = fam === OTHER_FAMILY ? t('filters.family_other') : fam;
      return Markup.button.callback(on ? `✅ ${label}` : label, `style:${fam}`);
    });
    styleRows.push(row);
  }

  const abvBtn = (b: (typeof ABV_PRESETS)[number]) =>
    Markup.button.callback(b.key === state.abvKey ? `✅ ${b.label}` : b.label, `abv:${b.key}`);
  const abvCapRow = ABV_PRESETS.filter((b) => b.max != null).map(abvBtn); // ≤X
  const abvFloorRow = ABV_PRESETS.filter((b) => b.min != null).map(abvBtn); // X+

  const ratingRow = RATING_PRESETS.map((r) =>
    Markup.button.callback(state.minRating === r ? `✅ min ${r}` : `min ${r}`, `rating:${r}`),
  );

  return Markup.inlineKeyboard([
    ...styleRows,
    abvCapRow,
    abvFloorRow,
    ratingRow,
    [Markup.button.callback(t('filters.reset_button'), 'reset')],
  ]);
};
