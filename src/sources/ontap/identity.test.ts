import { stripTrailingSpec } from './identity';

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
