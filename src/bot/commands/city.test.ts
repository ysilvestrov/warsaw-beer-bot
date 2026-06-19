import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';
import { cityKeyboard } from '../keyboards';
import { applyCitySelection } from './city';

test('cityKeyboard marks the current city', () => {
  const kb = cityKeyboard('krakow') as any;
  const flat: any[] = kb.reply_markup.inline_keyboard.flat();
  const krakow = flat.find((b: any) => b.callback_data === 'city:krakow');
  const warszawa = flat.find((b: any) => b.callback_data === 'city:warszawa');
  expect(krakow.text).toBe('✓ Kraków');
  expect(warszawa.text).toBe('Warszawa');
});

test('a known slug is stored, an unknown slug is ignored', () => {
  const db = openDb(':memory:'); migrate(db);
  ensureProfile(db, 7);
  expect(applyCitySelection(db, 7, 'krakow')).toBe(true);
  expect(getUserCity(db, 7)).toBe('krakow');
  expect(applyCitySelection(db, 7, 'atlantis')).toBe(false);
  expect(getUserCity(db, 7)).toBe('krakow');
});
