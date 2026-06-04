import { normalizeName, normalizeBrewery, stripBreweryNoise } from './normalize';

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

describe('stripBreweryNoise', () => {
  test('drops a trailing "Brewery" suffix', () => {
    expect(stripBreweryNoise('JBW Brewery')).toBe('JBW');
  });
  test('drops "Browar" in any position', () => {
    expect(stripBreweryNoise('Browar Pinta')).toBe('Pinta');
  });
  test('preserves case and diacritics of non-noise tokens', () => {
    expect(stripBreweryNoise('Gościszewo Brewery')).toBe('Gościszewo');
  });
  test('multi-word brewery keeps all non-noise words', () => {
    expect(stripBreweryNoise('Trzech Kumpli Brewery')).toBe('Trzech Kumpli');
  });
  test('all-noise brewery collapses to empty string', () => {
    expect(stripBreweryNoise('Browar')).toBe('');
  });
  test('brewery with no noise words is unchanged', () => {
    expect(stripBreweryNoise('Magic Road')).toBe('Magic Road');
  });
});

describe('multilingual brewery descriptors', () => {
  test('normalizeBrewery strips foreign brewery words', () => {
    expect(normalizeBrewery('Pivovar Černá Hora')).toBe('cerna hora');
    expect(normalizeBrewery('Měšťanský Pivovary Polička')).toBe('mestansky policka');
    expect(normalizeBrewery('Brauerei Aying')).toBe('aying');
    expect(normalizeBrewery('Brasserie Dupont')).toBe('dupont');
    expect(normalizeBrewery('Birrificio Italiano')).toBe('italiano');
    expect(normalizeBrewery('Brouwerij Bosteels')).toBe('bosteels');
    expect(normalizeBrewery('Stigbergets Bryggeri')).toBe('stigbergets');
    expect(normalizeBrewery('Nya Carnegie Bryggeriet')).toBe('nya carnegie');
    expect(normalizeBrewery('Cervecería Maier')).toBe('maier');
    expect(normalizeBrewery('Browary Regionalne')).toBe('regionalne');
  });

  test('stripBreweryNoise drops Pivovar in any position (case-insensitive)', () => {
    expect(stripBreweryNoise('Pivovar Polička')).toBe('Polička');
    expect(stripBreweryNoise('Cerna Hora Pivovar')).toBe('Cerna Hora');
  });
});
