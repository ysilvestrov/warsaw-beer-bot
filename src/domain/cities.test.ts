import { CITIES, isKnownCity, cityLabel, OUTSIDE_CITY, isSelectableCity } from './cities';

describe('cities', () => {
  test('isKnownCity recognises configured slugs and rejects others', () => {
    expect(isKnownCity('warszawa')).toBe(true);
    expect(isKnownCity('krakow')).toBe(true);
    expect(isKnownCity('lublin')).toBe(true);
    expect(isKnownCity('szczecin')).toBe(true);
    expect(isKnownCity('atlantis')).toBe(false);
    expect(isKnownCity('')).toBe(false);
  });
  test('cityLabel returns the label for a known slug, echoes unknown', () => {
    expect(cityLabel('warszawa')).toBe('Warszawa');
    expect(cityLabel('lublin')).toBe('Lublin');
    expect(cityLabel('szczecin')).toBe('Szczecin');
    expect(cityLabel('atlantis')).toBe('atlantis');
  });

  test('OUTSIDE_CITY is selectable but is NOT a crawlable ontap city', () => {
    // CITIES is what refreshOntap iterates over — the pseudo-city must never leak in,
    // or the crawler would fetch ontap.pl/outside-pl.
    expect(CITIES.some((c) => c.slug === OUTSIDE_CITY)).toBe(false);
    expect(isKnownCity(OUTSIDE_CITY)).toBe(false);
    expect(isSelectableCity(OUTSIDE_CITY)).toBe(true);
  });

  test('isSelectableCity accepts real cities and rejects unknown slugs', () => {
    expect(isSelectableCity('warszawa')).toBe(true);
    expect(isSelectableCity('szczecin')).toBe(true);
    expect(isSelectableCity('atlantis')).toBe(false);
    expect(isSelectableCity('')).toBe(false);
  });
});
