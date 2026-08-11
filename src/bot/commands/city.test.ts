import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import { CITIES, OUTSIDE_CITY } from '../../domain/cities';
import { cityKeyboard } from '../keyboards';
import { applyCitySelection } from './city';

const t = createTranslator('en');

function flat(kb: ReturnType<typeof cityKeyboard>) {
  return kb.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];
}

test('cityKeyboard marks the current city', () => {
  const all = flat(cityKeyboard(t, 'krakow'));
  expect(all.find((b) => b.callback_data === 'city:krakow')!.text).toBe('✓ Kraków');
  expect(all.find((b) => b.callback_data === 'city:warszawa')!.text).toBe('Warszawa');
});

test('the outside-Poland button is always the last row', () => {
  const rows = cityKeyboard(t, 'krakow').reply_markup.inline_keyboard as {
    callback_data: string;
  }[][];
  expect(rows).toHaveLength(CITIES.length + 1);
  expect(rows[rows.length - 1].map((b) => b.callback_data)).toEqual([`city:${OUTSIDE_CITY}`]);
});

test('the outside-Poland button carries the localized label and takes the ✓ when active', () => {
  const all = flat(cityKeyboard(t, OUTSIDE_CITY));
  expect(all.find((b) => b.callback_data === `city:${OUTSIDE_CITY}`)!.text)
    .toBe('✓ 🌍 Outside Poland');
  expect(all.find((b) => b.callback_data === 'city:warszawa')!.text).toBe('Warszawa');
  expect(flat(cityKeyboard(createTranslator('pl'), 'krakow'))
    .find((b) => b.callback_data === `city:${OUTSIDE_CITY}`)!.text).toBe('🌍 Poza Polską');
});

test('a known slug is stored, an unknown slug is ignored', () => {
  const db = openDb(':memory:'); migrate(db);
  ensureProfile(db, 7);
  expect(applyCitySelection(db, 7, 'krakow')).toBe(true);
  expect(getUserCity(db, 7)).toBe('krakow');
  expect(applyCitySelection(db, 7, 'atlantis')).toBe(false);
  expect(getUserCity(db, 7)).toBe('krakow');
});

test('the pseudo-city is a storable choice (#399)', () => {
  const db = openDb(':memory:'); migrate(db);
  ensureProfile(db, 8);
  expect(applyCitySelection(db, 8, 'krakow')).toBe(true);
  expect(applyCitySelection(db, 8, OUTSIDE_CITY)).toBe(true);
  expect(getUserCity(db, 8)).toBe(OUTSIDE_CITY);
});
