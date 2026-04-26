import { normalizeName, normalizeBrewery } from './normalize';

test('lowercases and strips diacritics', () => {
  expect(normalizeName('Atak Chmielu — Imperial')).toBe('atak chmielu');
  expect(normalizeName('Łyso Pysk')).toBe('lyso pysk');
});

test('removes common style noise', () => {
  expect(normalizeName('Piwo IPA (session)')).toBe('piwo');
  expect(normalizeName('Double Dry Hopped NEIPA Hopinka')).toBe('hopinka');
});

test('normalizes brewery the same way, no style stripping', () => {
  expect(normalizeBrewery('Browar Stu Mostów')).toBe('stu mostow');
});

test('strips numeric tokens (ABV / strength / years)', () => {
  // Real ontap-style raw string after baseNormalize splits punctuation.
  expect(normalizeName('Buzdygan Rozkoszy 24°·8,5%')).toBe('buzdygan rozkoszy');
  // Year-only tokens — vintages of the same beer collapse to one key.
  expect(normalizeName('Buzdygan Rozkoszy 2026')).toBe('buzdygan rozkoszy');
  expect(normalizeName('Buzdygan Rozkoszy 2024')).toBe('buzdygan rozkoszy');
  // Brewery normalizer follows the same rule.
  expect(normalizeBrewery('Browar Stu 8,5%')).toBe('stu');
});

test('strips every Polish diacritic', () => {
  expect(normalizeBrewery('ąćęłńóśźż')).toBe('acelnoszz');
  expect(normalizeBrewery('ĄĆĘŁŃÓŚŹŻ')).toBe('acelnoszz');
  expect(normalizeBrewery('Żywiec')).toBe('zywiec');
  expect(normalizeBrewery('Średnica')).toBe('srednica');
  expect(normalizeBrewery('Księżyc')).toBe('ksiezyc');
  expect(normalizeBrewery('Piąte')).toBe('piate');
});
