import { extractBeerName, resolveTapIdentity, sanitizeBrewery, stripTrailingSpec } from './identity';

describe('stripTrailingSpec', () => {
  test.each([
    // [input, expected]
    ['Konrad 12° · 5,2%', 'Konrad 12°'],                                    // grade kept, ABV stripped
    ['Bajlando za mango 16°·5,8%%', 'Bajlando za mango 16°'],               // doubled %%
    ['Fizzy 7,7°·2,8%%', 'Fizzy 7,7°'],
    ['Lajtowe 4,5°·0,0%%', 'Lajtowe 4,5°'],
    ['Pszeniczne 12°°·5%', 'Pszeniczne 12°'],                               // doubled °°
    ['CIESZYN PILSNER 11,8%°·4,8%%', 'CIESZYN PILSNER 11,8°'],              // mangled %°
    ['Cookie Monster Ice Destilated N/D°·13%', 'Cookie Monster Ice Destilated'], // N/D is not a grade
    ['Free <0.5°·<0,5%', 'Free'],                                           // "<" ⇒ not a grade
    ['Green IQ <0,5%', 'Green IQ'],
    ['NoLo - Hoptimista <0.5%', 'NoLo - Hoptimista'],
    ['Pilsiwko 0%', 'Pilsiwko'],
    ['Plum Plum Plum 12,5°·4', 'Plum Plum Plum 12,5°'],                     // truncated tail
    ['This ls light 8°·3;5%', 'This ls light 8°'],                          // ";" decimal typo
    ['Beer 8;5°·3;5%', 'Beer 8,5°'],                                        // ";" decimal in the grade
    ['PAN IPANI BEZALKOHOLOWE 8°·<0.5%', 'PAN IPANI BEZALKOHOLOWE 8°'],
    ['ZGRYFUS | Pastry Sour Ale Blackcurrant & Cherry 5%%',
     'ZGRYFUS | Pastry Sour Ale Blackcurrant & Cherry'],
    ['Buzdygan Rozkoszy 24°·8,5%', 'Buzdygan Rozkoszy 24°'],
    ['Salamander 6%', 'Salamander'],
    // a style tail appended after the spec block is part of the spec, not of the name
    ['Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale', 'Wagabunda Brewery Oxymel 14°'],
    ['Oxymel 12°·4,2% — Sour', 'Oxymel 12°'],
    // must NOT be touched
    ['La 150° Bionda 8,5%', 'La 150° Bionda'],                              // interior degree
    ['Litovel Pomelo 0% 12°·<0,5%', 'Litovel Pomelo 0% 12°'],               // interior 0% kept
    ['300% Normy', '300% Normy'],                                           // spec is not trailing
    ['11%', '11%'],                                                         // would empty the name
    ['12 12°·4', '12 12°'],
    ['Aperitivo Spritz', 'Aperitivo Spritz'],                               // no spec at all
  ])('%s → %s', (input, expected) => {
    expect(stripTrailingSpec(input)).toBe(expected);
  });
});

describe('sanitizeBrewery', () => {
  test('clears a known polluted brewery instead of discarding the beer', () => {
    expect(sanitizeBrewery('W Brzesku Brewery', 'Žatecký Nealko'))
      .toEqual({ brewery: '', name: 'Žatecký Nealko' });
    expect(sanitizeBrewery('vaisiu sultys', 'Obuolių'))
      .toEqual({ brewery: '', name: 'Obuolių' });
  });

  test('recognises a polluted brewery regardless of a trailing kind word', () => {
    expect(sanitizeBrewery('vaisiu sultys Brewery', 'Obuolių'))
      .toEqual({ brewery: '', name: 'Obuolių' });
    expect(sanitizeBrewery('W Brzesku', 'Žatecký Světlý Ležák'))
      .toEqual({ brewery: '', name: 'Žatecký Světlý Ležák' });
  });

  test('clears a punctuation-only brewery', () => {
    expect(sanitizeBrewery('- Brewery', 'Pilsner Urquell'))
      .toEqual({ brewery: '', name: 'Pilsner Urquell' });
  });

  test('maps the generic Cydr Dzik listing to the real cidery', () => {
    expect(sanitizeBrewery('CYDR DZIK', 'polski cydr'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik' });
    expect(sanitizeBrewery('CYDR DZIK Brewery', 'Cydr Jabłko'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik Jabłko' });
    expect(sanitizeBrewery('CYDR DZIK Brewery', 'Jabłko'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik Jabłko' });
  });

  test('does not invent a Cydr Dzik product name from a bare cider label', () => {
    expect(sanitizeBrewery('CYDR DZIK Brewery', 'Cydr'))
      .toEqual({ brewery: 'CYDR DZIK Brewery', name: 'Cydr' });
  });

  test('does not double the Dzik product token when beer_ref is already "Cydr Dzik"', () => {
    expect(sanitizeBrewery('Cydr Dzik', 'Cydr Dzik'))
      .toEqual({ brewery: 'Cydrownia', name: 'Dzik' });
  });

  test('maps Cydr Flirt Tradycynis rows to Kauno Alus product names', () => {
    expect(sanitizeBrewery('Cydr Flirt Tradycynis', 'Cydr malina i skórka pomarańczowa'))
      .toEqual({ brewery: 'Kauno Alus', name: 'Tradycynis Cydr Flirt malina i skórka pomarańczowa' });
    expect(sanitizeBrewery('Cydr Flirt Tradycynis', ''))
      .toEqual({ brewery: 'Kauno Alus', name: 'Tradycynis Cydr Flirt' });
  });

  test('strips a duplicated cider prefix that repeats the brewery', () => {
    expect(sanitizeBrewery('Chyliczki', 'Cydr Chyliczki - Japoński Sad'))
      .toEqual({ brewery: 'Chyliczki', name: 'Japoński Sad' });
  });

  test('passes an ordinary brewery through untouched', () => {
    expect(sanitizeBrewery('Pinta Brewery', 'Atak Chmielu'))
      .toEqual({ brewery: 'Pinta Brewery', name: 'Atak Chmielu' });
  });
});

describe('extractBeerName', () => {
  test('strips the brewery prefix and the trailing spec', () => {
    expect(extractBeerName('Harpagan Brewery Buzdygan Rozkoszy 24°·8,5%', 'Harpagan Brewery'))
      .toBe('Buzdygan Rozkoszy 24°');
    expect(extractBeerName('Stu Mostów WRCLW Salamander 6%', 'Stu Mostów'))
      .toBe('WRCLW Salamander');
  });

  test('keeps the brand inside the title when only the core matches (no catalog churn)', () => {
    expect(extractBeerName('PINTA Atak Chmielu 6%', 'PINTA Brewery')).toBe('PINTA Atak Chmielu');
  });

  test('is case-insensitive on the brewery prefix', () => {
    expect(extractBeerName('PINTA Atak Chmielu 6%', 'Pinta')).toBe('Atak Chmielu');
  });

  test('keeps the name when it is exactly the brand (#306: never empty it)', () => {
    expect(extractBeerName('Guinness Brewery Guinness', 'Guinness Brewery')).toBe('Guinness');
    expect(extractBeerName('Pinta', 'Pinta')).toBe('Pinta');
    expect(extractBeerName('Cydr Dzik', 'Cydr Dzik')).toBe('Cydr Dzik');
  });

  test('keeps an interior degree mark that is part of the name', () => {
    expect(extractBeerName('Birra Menabrea Brewery La 150° Bionda 4,8%', 'Birra Menabrea Brewery'))
      .toBe('La 150° Bionda');
  });

  test('returns the full text when there is no brewery and no spec', () => {
    expect(extractBeerName('Aperitivo Spritz', null)).toBe('Aperitivo Spritz');
  });

  test('does not reduce a brand-plus-grade title to the bare grade', () => {
    expect(extractBeerName('Konrad Brewery 12°·5%', 'Konrad Brewery')).toBe('Konrad 12°');
    expect(extractBeerName('Bernard Brewery 11°·5%', 'Bernard Brewery')).toBe('Bernard 11°');
  });

  // Live rows from the first production run after #306 shipped (2026-07-30).
  test('collapses a grade the shop wrote both in the name and in the spec', () => {
    expect(extractBeerName('Konicek Brewery 10 10°·4%', 'Konicek Brewery')).toBe('Konicek 10°');
    expect(extractBeerName('Platan Brewery svetly leżak 11 11°·4,7%', 'Platan Brewery'))
      .toBe('svetly leżak 11°');
    expect(extractBeerName('Pivovar Zichovec Brewery Bridge Please! 12 12°·5%', 'Pivovar Zichovec Brewery'))
      .toBe('Bridge Please! 12°');
    expect(extractBeerName('Litovel Brewery Litovel Premium 12° 12°·5%', 'Litovel Brewery'))
      .toBe('Litovel Premium 12°');
  });

  test('keeps a trailing number that is not the grade', () => {
    expect(extractBeerName('Funky Fluid Brewery Batch 1000 12°·6%', 'Funky Fluid Brewery'))
      .toBe('Batch 1000 12°');
    expect(extractBeerName('Holba Brewery Holba 11 Premium 12,5°·5.2%', 'Holba Brewery'))
      .toBe('Holba 11 Premium 12,5°');
  });
});

describe('resolveTapIdentity', () => {
  test.each([
    ['Guinness Brewery', 'Guinness', 'Guinness Brewery', 'Guinness'],
    ['Pilsner Urquell Brewery', 'Pilsner Urquell', 'Pilsner Urquell Brewery', 'Pilsner Urquell'],
    ['Holba Brewery', 'Holba', 'Holba Brewery', 'Holba'],
    ['Cydr Dobroński', 'Cydr Dobroński', 'Cydr Dobroński', 'Cydr Dobroński'],
    ['Frankies Brewery', 'Frankies', 'Frankies Brewery', 'Frankies'],
    ['Konrad Brewery', 'Konrad 12° · 5,2%', 'Konrad Brewery', 'Konrad 12°'],
  ])('keeps %s | %s', (breweryRef, beerRef, brewery, name) => {
    expect(resolveTapIdentity(breweryRef, beerRef)).toEqual({ kind: 'keep', brewery, name });
  });

  test('keeps the beer when the brewery field is polluted', () => {
    expect(resolveTapIdentity('W Brzesku Brewery', 'Žatecký Nealko'))
      .toEqual({ kind: 'keep', brewery: '', name: 'Žatecký Nealko' });
  });

  test('drops only an empty name', () => {
    expect(resolveTapIdentity('Some Brewery', '')).toEqual({ kind: 'drop', reason: 'empty-name' });
    expect(resolveTapIdentity('Some Brewery', '   ')).toEqual({ kind: 'drop', reason: 'empty-name' });
  });
});

describe('#306 follow-up: same-number spec written twice', () => {
  test('collapses a "%"-spelled duplicate of the grade', () => {
    expect(extractBeerName('Primator Brewery 11% 11°·4,7%', 'Primator Brewery')).toBe('Primator 11°');
  });

  test('keeps an interior percentage that is a different number', () => {
    expect(extractBeerName('Litovel Brewery Litovel Pomelo 0% 12°·<0,5%', 'Litovel Brewery'))
      .toBe('Litovel Pomelo 0% 12°');
  });
});
