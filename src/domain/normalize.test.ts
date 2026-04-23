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
