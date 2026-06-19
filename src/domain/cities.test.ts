import { CITIES, DEFAULT_CITY, isKnownCity, cityLabel } from './cities';

describe('cities', () => {
  test('DEFAULT_CITY is one of the configured cities', () => {
    expect(CITIES.some((c) => c.slug === DEFAULT_CITY)).toBe(true);
  });
  test('isKnownCity recognises configured slugs and rejects others', () => {
    expect(isKnownCity('warszawa')).toBe(true);
    expect(isKnownCity('krakow')).toBe(true);
    expect(isKnownCity('atlantis')).toBe(false);
    expect(isKnownCity('')).toBe(false);
  });
  test('cityLabel returns the label for a known slug, echoes unknown', () => {
    expect(cityLabel('warszawa')).toBe('Warszawa');
    expect(cityLabel('atlantis')).toBe('atlantis');
  });
});
