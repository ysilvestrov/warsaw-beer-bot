import { createTranslator } from '../i18n';
import { OUTSIDE_CITY } from '../domain/cities';
import { cityDisplayLabel } from './city-label';

test('real cities keep their static label, regardless of locale', () => {
  expect(cityDisplayLabel(createTranslator('uk'), 'warszawa')).toBe('Warszawa');
  expect(cityDisplayLabel(createTranslator('en'), 'krakow')).toBe('Kraków');
});

test('the pseudo-city label is translated', () => {
  expect(cityDisplayLabel(createTranslator('uk'), OUTSIDE_CITY)).toBe('🌍 Поза Польщею');
  expect(cityDisplayLabel(createTranslator('pl'), OUTSIDE_CITY)).toBe('🌍 Poza Polską');
  expect(cityDisplayLabel(createTranslator('en'), OUTSIDE_CITY)).toBe('🌍 Outside Poland');
});

test('an unknown slug is echoed, as cityLabel does', () => {
  expect(cityDisplayLabel(createTranslator('en'), 'atlantis')).toBe('atlantis');
});
