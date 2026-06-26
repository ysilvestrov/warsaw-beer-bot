import { isOntapNonBeerTap } from './non-beer';

describe('isOntapNonBeerTap', () => {
  test.each([
    ['style prosecco', { style: 'PROSECCO', brewery_ref: 'Cantine Vitevis' }],
    ['style vino', { style: 'Vino Bianco', brewery_ref: 'Conegliano Brewery' }],
    ['style frizzante', { style: 'Frizzante [wino musujące]', brewery_ref: 'Maccari' }],
    ['style spritz', { style: 'Aperol Spritz', brewery_ref: 'Maccari / Frizzanti' }],
    ['style cocktail', { style: 'Koktajl na bazie wina musującego', brewery_ref: 'Maccari / Frizzanti' }],
    ['exact cocktail style', { style: 'Drink, czarny bez, mięta i limonka', brewery_ref: 'Monte Santi Brewery' }],
    ['wine brewery', { style: null, brewery_ref: 'Dolium Vini' }],
    ['san martino brewery', { style: null, brewery_ref: 'SAN MARTINO' }],
    ['hugo sentinel brewery', { style: null, brewery_ref: 'HUGO' }],
    ['mojito sentinel brewery', { style: null, brewery_ref: 'MOJITO' }],
    ['style cocktail english', { style: 'Cocktail', brewery_ref: 'Nalej Se Brewery', beer_ref: 'Mai Tai' }],
    ['style cocktail english 2', { style: 'Cocktail', brewery_ref: 'Nalej Se Brewery', beer_ref: 'Bramble' }],
    ['style nalewka', { style: 'Nalewka', brewery_ref: 'Nalej Se Brewery', beer_ref: 'Nalewka gruszkowa' }],
    ['style szprycer', { style: 'Szprycer', brewery_ref: 'Nalej Se Brewery', beer_ref: 'Big Diva' }],
    ['style kombucha', { style: 'Kombucha', brewery_ref: 'Koko Kombucha Brewery', beer_ref: 'Imbir' }],
    ['style wine grapes glera', { style: 'Chardonnay, Glera and Garganega', brewery_ref: 'Cantina della Valle', beer_ref: 'Vino Bianco Frizzante' }],
  ])('flags %s', (_label, tap) => {
    expect(isOntapNonBeerTap(tap)).toBe(true);
  });

  test.each([
    ['cider Polish', { style: 'Cydr Wytrawny', brewery_ref: 'Chyliczki' }],
    ['cider Polish neuter dry descriptor', { style: 'Cydr wytrawne', brewery_ref: 'Chyliczki' }],
    ['cider Polish semi-dry descriptor', { style: 'Cydr półwytrawne', brewery_ref: 'Chyliczki' }],
    ['cider Polish sweet descriptor', { style: 'Cydr słodkie', brewery_ref: 'Chyliczki' }],
    ['cider English', { style: 'Sweet cider', brewery_ref: 'PRZETWÓRNIA CHMIELU' }],
    ['kvass Polish', { style: 'Kwas chlebowy', brewery_ref: 'Vilniaus Alus Brewery' }],
    ['kvass Cyrillic', { style: 'Квас', brewery_ref: 'Stacja Winiarska' }],
    ['kvass Cyrillic with descriptor', { style: 'Квас хлібний', brewery_ref: 'Dolium Vini' }],
    ['kvass English', { style: 'Traditional Kvass', brewery_ref: 'Baltic Glass Brewery' }],
    ['kvass beer name but safe style', { style: 'Catharina Sour', brewery_ref: 'PINTA Brewery' }],
    ['mead', { style: 'Mead - Melomel', brewery_ref: 'Berryland' }],
    ['mead Polish sweet descriptor', { style: 'Mead półsłodkie', brewery_ref: 'Berryland' }],
    ['melomel sweet descriptor', { style: 'Melomel słodkie', brewery_ref: 'Berryland' }],
    ['normal beer', { style: 'West Coast IPA', brewery_ref: 'PINTA Brewery' }],
    ['drinkability prose does not match generic drink', {
      style: 'Dark, smooth, and deceptively light on the palate, endlessly drinkable Schwarzbier',
      brewery_ref: 'FUERST WIACEK Berlin Brewery',
    }],
  ])('keeps %s eligible', (_label, tap) => {
    expect(isOntapNonBeerTap(tap)).toBe(false);
  });

  test('does not inspect beer_ref/name', () => {
    const tapWithName = {
      style: null,
      brewery_ref: 'Beer Brewery',
      beer_ref: 'Vino Merlot Spritz Prosecco',
    };
    expect(isOntapNonBeerTap(tapWithName)).toBe(false);
  });
});
