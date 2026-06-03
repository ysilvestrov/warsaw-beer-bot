import { filtersKeyboard } from './keyboards';
import type { Translator } from '../i18n/types';

const t: Translator = (key) => {
  if (key === 'filters.reset_button') return '♻️ Reset all';
  if (key === 'filters.family_other') return 'Інше';
  return String(key);
};

function buttons(markup: ReturnType<typeof filtersKeyboard>) {
  return markup.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];
}

test('filtersKeyboard marks active style with ✓ and keeps callback data clean', () => {
  const kb = filtersKeyboard(t, {
    families: ['IPA', 'Sour', 'Pale Ale'],
    activeStyles: ['IPA'],
    abvKey: null,
    minRating: null,
  });
  const all = buttons(kb);
  const ipa = all.find((b) => b.callback_data === 'style:IPA')!;
  const sour = all.find((b) => b.callback_data === 'style:Sour')!;
  const pale = all.find((b) => b.callback_data === 'style:Pale Ale')!;
  expect(ipa.text).toBe('✅ IPA');
  expect(sour.text).toBe('Sour');
  expect(pale.text).toBe('Pale Ale'); // family with a space round-trips in callback_data
});

test('filtersKeyboard renders ABV buckets, rating presets and reset; marks active', () => {
  const kb = filtersKeyboard(t, {
    families: [],
    activeStyles: [],
    abvKey: 'gte9',
    minRating: 3.8,
  });
  const all = buttons(kb);
  expect(all.find((b) => b.callback_data === 'abv:gte9')!.text).toBe('✅ 9%+');
  expect(all.find((b) => b.callback_data === 'abv:lte5')!.text).toBe('≤5%');
  expect(all.find((b) => b.callback_data === 'rating:3.8')!.text).toBe('✅ min 3.8');
  expect(all.find((b) => b.callback_data === 'rating:3.5')!.text).toBe('min 3.5');
  expect(all.find((b) => b.callback_data === 'reset')!.text).toBe('♻️ Reset all');
});

test('filtersKeyboard splits ABV into a caps row and a floors row', () => {
  const kb = filtersKeyboard(t, { families: [], activeStyles: [], abvKey: null, minRating: null });
  const rows = kb.reply_markup.inline_keyboard as { callback_data: string }[][];
  expect(rows[0].map((b) => b.callback_data)).toEqual(['abv:lte3_5', 'abv:lte5']);
  expect(rows[1].map((b) => b.callback_data)).toEqual(['abv:gte5', 'abv:gte7', 'abv:gte9']);
});

test('filtersKeyboard renders the Other family with its localized label, raw callback', () => {
  const kb = filtersKeyboard(t, {
    families: ['IPA', 'Other'],
    activeStyles: ['Other'],
    abvKey: null,
    minRating: null,
  });
  const all = buttons(kb);
  const other = all.find((b) => b.callback_data === 'style:Other')!;
  expect(other.text).toBe('✅ Інше'); // localized label, ✓ because active; callback stays style:Other
  expect(all.find((b) => b.callback_data === 'style:IPA')!.text).toBe('IPA');
});
