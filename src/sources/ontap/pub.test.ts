import fs from 'node:fs';
import path from 'node:path';
import { parsePubPage, extractBeerName } from './pub';

const html = fs.readFileSync(
  path.join(__dirname, '../../../tests/fixtures/ontap/beer-bones.html'),
  'utf8',
);

test('parses pub metadata', () => {
  const result = parsePubPage(html);
  expect(result.pub.name).toMatch(/beer.*bones/i);
  expect(result.pub.address).toMatch(/Żurawia/);
  expect(result.pub.lat).toBeCloseTo(52.228, 2);
  expect(result.pub.lon).toBeCloseTo(21.013, 2);
});

test('parses taps with beer_ref and abv', () => {
  const { taps } = parsePubPage(html);
  expect(taps.length).toBeGreaterThanOrEqual(10);
  const withAbv = taps.filter((t) => t.abv !== null);
  expect(withAbv.length).toBeGreaterThan(0);
  for (const t of taps) expect(t.beer_ref.length).toBeGreaterThan(0);
});

test('beer_ref is clean — no ABV / strength tokens', () => {
  const { taps } = parsePubPage(html);
  for (const t of taps) {
    expect(t.beer_ref).not.toMatch(/\d+\s*[°%]/);
  }
});

test('style is populated when subtitle exists', () => {
  const { taps } = parsePubPage(html);
  // At least some taps in a real ontap page have a style subtitle.
  const withStyle = taps.filter((t) => t.style && t.style.length > 0);
  expect(withStyle.length).toBeGreaterThan(0);
});

describe('extractBeerName', () => {
  test('truncates at first ABV-like token', () => {
    expect(extractBeerName('Buzdygan Rozkoszy 24°·8,5%', null)).toBe('Buzdygan Rozkoszy');
    expect(extractBeerName('Pan IPAni 16,5°·6%', null)).toBe('Pan IPAni');
    expect(extractBeerName('Salamander 6%', null)).toBe('Salamander');
  });

  test('strips brewery prefix when present', () => {
    expect(extractBeerName('Harpagan Brewery Buzdygan Rozkoszy 24°·8,5%', 'Harpagan Brewery'))
      .toBe('Buzdygan Rozkoszy');
    expect(extractBeerName('Stu Mostów WRCLW Salamander 6%', 'Stu Mostów'))
      .toBe('WRCLW Salamander');
  });

  test('case-insensitive brewery match', () => {
    expect(extractBeerName('PINTA Atak Chmielu 6%', 'Pinta'))
      .toBe('Atak Chmielu');
  });

  test('returns full text when no ABV pattern is found', () => {
    expect(extractBeerName('Aperitivo Spritz', null)).toBe('Aperitivo Spritz');
  });

  test('returns empty string when only brewery is present', () => {
    expect(extractBeerName('Pinta', 'Pinta')).toBe('');
  });
});
