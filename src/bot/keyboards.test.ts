import { filtersKeyboard } from './keyboards';
import type { Translator } from '../i18n/types';

const t: Translator = (key) => (key === 'filters.reset_button' ? '♻️ Reset all' : String(key));

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
    abvKey: '9plus',
    minRating: 3.8,
  });
  const all = buttons(kb);
  expect(all.find((b) => b.callback_data === 'abv:9plus')!.text).toBe('✅ 9%+');
  expect(all.find((b) => b.callback_data === 'abv:0-5')!.text).toBe('≤5%');
  expect(all.find((b) => b.callback_data === 'rating:3.8')!.text).toBe('✅ min 3.8');
  expect(all.find((b) => b.callback_data === 'rating:3.5')!.text).toBe('min 3.5');
  expect(all.find((b) => b.callback_data === 'reset')!.text).toBe('♻️ Reset all');
});
