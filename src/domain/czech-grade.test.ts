import { extractGrade, isAleStyle, isDark, extraDescriptorCount } from './czech-grade';

describe('extractGrade', () => {
  test('spelled Czech grade words → number (diacritic-stripped input)', () => {
    expect(extractGrade('Desitka')).toBe(10);
    expect(extractGrade('Desítka')).toBe(10);
    expect(extractGrade('Dvanactka')).toBe(12);
    expect(extractGrade('Dvanáctka')).toBe(12);
    expect(extractGrade('Dvanastka')).toBe(12); // observed shop misspelling (beer_id 29429)
    expect(extractGrade('Osmicka')).toBe(8);
  });

  test('bare integer inside the Plato range', () => {
    expect(extractGrade('Trutnov 11')).toBe(11);
    expect(extractGrade('Kamenická 10')).toBe(10);
    expect(extractGrade('Ležák 11%')).toBe(11);
  });

  test('numbers outside 7–20 are not grades', () => {
    expect(extractGrade('Pinta 555')).toBeNull();
    expect(extractGrade('6')).toBeNull();
    expect(extractGrade('21')).toBeNull();
    expect(extractGrade('Buzdygan Rozkoszy 2026')).toBeNull();
  });

  test('names with no grade signal → null', () => {
    expect(extractGrade('Premium pszenica')).toBeNull();
    expect(extractGrade('Hopinka')).toBeNull();
  });
});

describe('isAleStyle', () => {
  test('true for ale style via the Untappd style label', () => {
    expect(isAleStyle('Góséčko mango+calamansi 11%', 'Gose')).toBe(true);
    expect(isAleStyle('Session IPA 11%', 'IPA - Session')).toBe(true);
  });

  test('true for ale style found in the beer name when style is null', () => {
    expect(isAleStyle('Nazwa Stout 11', null)).toBe(true);
  });

  test('false for a pale lager', () => {
    expect(isAleStyle('Ležák 11%', 'Czech Pale Lager')).toBe(false);
    expect(isAleStyle('Kamenická 10', null)).toBe(false);
  });
});

describe('isDark', () => {
  test('true for dark styles/names', () => {
    expect(isDark('Tmavý ležák 10°', 'Czech Dark Lager')).toBe(true);
    expect(isDark('Kamenická 12', 'Dark Lager')).toBe(true);
  });

  test('false for pale', () => {
    expect(isDark('Světlý ležák 11°', 'Czech Pale Lager')).toBe(false);
  });
});

describe('extraDescriptorCount', () => {
  test('plain lager has zero extra descriptors; seasonals have more', () => {
    expect(extraDescriptorCount('Světlý ležák 11°', 'krakonos', 11)).toBe(0);
    expect(extraDescriptorCount('Vánoční světlý ležák 11°', 'krakonos', 11)).toBe(1);
  });

  test('flavour tail counts as descriptors; grade + brand + lager words do not', () => {
    expect(extraDescriptorCount('Ležák 11%', 'nachmelena opice', 11)).toBe(0);
    expect(extraDescriptorCount('Góséčko mango calamansi 11%', 'nachmelena opice', 11)).toBe(3);
    expect(extraDescriptorCount('Kamenická 12', 'kamenice nad lipou', 12)).toBe(1);
  });
});
