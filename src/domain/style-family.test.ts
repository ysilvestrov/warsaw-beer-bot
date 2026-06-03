import { canonicalStyleFamily, OTHER_FAMILY } from './style-family';

test('IPA family — variants, compounds, casing', () => {
  for (const s of ['American IPA', 'West Coast IPA', 'Hazy IPA', 'AIPA', 'NEIPA', 'WEST COAST IPA', 'Session IPA', 'Cold IPA']) {
    expect(canonicalStyleFamily(s)).toBe('IPA');
  }
  expect(canonicalStyleFamily('Wheat IPA')).toBe('IPA'); // IPA wins over Wheat
});

test('Wheat family — multilingual', () => {
  for (const s of ['Weizen', 'Pszeniczne', 'Hefeweizen', 'HEFEWEIZEN', 'Witbier', 'Belgian Witbier', 'German Hefeweizen']) {
    expect(canonicalStyleFamily(s)).toBe('Wheat');
  }
});

test('Lager family — diacritics, Polish/Czech, Pils, Desitka', () => {
  for (const s of ['Lager', 'Pils', 'Czeski Lager', 'Svetlý Ležák', 'Svetly Lezak', 'Pale Lager', 'Vienna Lager', 'Desitka']) {
    expect(canonicalStyleFamily(s)).toBe('Lager');
  }
});

test('Lambic strips qualifier', () => {
  expect(canonicalStyleFamily('Lambic wiśniowy')).toBe('Lambic');
});

test('Sour absorbs Gose and Pastry Sour', () => {
  expect(canonicalStyleFamily('Pastry Sour')).toBe('Sour');
  expect(canonicalStyleFamily('Gose')).toBe('Sour');
});

test('Pastry Stout/Porter resolve to base family, not Sour (priority)', () => {
  expect(canonicalStyleFamily('Pastry Stout')).toBe('Stout');
  expect(canonicalStyleFamily('Pastry Porter')).toBe('Porter');
  expect(canonicalStyleFamily('Milk Stout')).toBe('Stout');
  expect(canonicalStyleFamily('India Export Porter')).toBe('Porter');
});

test('Pale Ale needs apa OR pale+ale; Pale Lager is not Pale Ale', () => {
  expect(canonicalStyleFamily('American Pale Ale')).toBe('Pale Ale');
  expect(canonicalStyleFamily('New Zealand APA')).toBe('Pale Ale');
  expect(canonicalStyleFamily('Pale Lager')).toBe('Lager');
});

test('unmatched / empty / null fall into Other', () => {
  expect(canonicalStyleFamily('PROSECCO')).toBe(OTHER_FAMILY);
  expect(canonicalStyleFamily('')).toBe(OTHER_FAMILY);
  expect(canonicalStyleFamily(null)).toBe(OTHER_FAMILY);
  expect(OTHER_FAMILY).toBe('Other');
});
