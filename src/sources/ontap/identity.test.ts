import { sanitizeBrewery, stripTrailingSpec } from './identity';

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
    ['PAN IPANI BEZALKOHOLOWE 8°·<0.5%', 'PAN IPANI BEZALKOHOLOWE 8°'],
    ['ZGRYFUS | Pastry Sour Ale Blackcurrant & Cherry 5%%',
     'ZGRYFUS | Pastry Sour Ale Blackcurrant & Cherry'],
    ['Buzdygan Rozkoszy 24°·8,5%', 'Buzdygan Rozkoszy 24°'],
    ['Salamander 6%', 'Salamander'],
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
