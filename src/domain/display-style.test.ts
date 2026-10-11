import { displayStyle, isDescription } from './display-style';

// Verbatim from prod `taps.style` (White Crow, 2026-09-28 … 2026-10-11): the six texts that broke /beers.
const LIVE_DESCRIPTIONS = [
  "It is a special edition of our La Tomatina Originale brewed for La Tomatina Day 2026 together with our Tomato-mates from Ziemia Obiecana. Cheers",
  "Dessert-Inspired Cream Ale / Milkshake Ale. Brewed with malted barley and oats, enriched with lactose, vanilla, dulce de leche, and biscuit extracts. Creamy and silky, with rich caramel and vanilla sweetness, soft biscuit notes, and a luscious, full-bodied mouthfeel. Smooth, indulgent, and decadently drinkable like a dessert in a glass.",
  "Seria, w której stawiamy na chmielowe eksperymenty. Ekstrakt chmielu Sabro® DynaBoost™ to magiczny składnik, który trafia do piwa na etapie whirlpoola. Pozwala wzmocnić jego chmielowy charakter. A series in which we focus on hop experiments. Sabro® DynaBoost™ hop extract is a magical ingredient added to the beer during the whirlpool stage. It enhances the beer's hop character.",
  "Seria, w której stawiamy na chmielowe eksperymenty. Przed Wami mętne, podwójne IPA, w którym prym wiedzie czysta lupulina chmielu Krush®. To oznacza podwójną dawkę aromatów owoców tropikalnych i cytrusów. A series in which we focus on hop experiments. Here is a hazy Double IPA where the pure lupulin of the Krush® hop takes center stage. This means a double dose of tropical fruit and citrus aromas.",
  "Ahhhh the old country. Where the grass is green and the pints are cream. The first Garage nitro stout is a proper cream pot. Brewed with a simple grist and a good dose of traditional drum roasted barley as is only proper. But we have made a few tweaks to give this a slight biscuit character to compliment that beautiful dark chocolatey, coffee roast flavour. This is a Garage bar exclusive and one of the few places that we know of where you will get a nitro pour in Barcelona. So come in, sit down by a pretend fireplace and getting slurping on this sexy pint!",
  "The days are getting shorter and cooler so it's time to embrace comforting, easy drinking malty beers. The malty goodness is brought to you by high quality Maris Otter malt and some fine English caramel malts that were fermented on a guest yeast strain that is more well known for IPAs but the fruity apricot esters that it bring fit so well here. A moderate hopping with a newer American variety brings complimentary notes of apricot, orange and tangerine. While some of these ingredients are not necessarily true to style, the overall impression of this beer is very much what one would expect form a Best Bitter.",
];

// Verbatim from prod: real styles that look closest to a description.
const LIVE_STYLES = [
  'Sour Ale w. Cherry & Blueberry',
  'Catharina Sour w. Peach Mango Calamansi Passionfruit',
  'Ice Cream Sour w. Lingonberry, Blueberry, Raspberry, Cranberry, Cinnamon, Vanilla & Maple Syrup',
  'Kwaśne Ale z 10 owocami agrest wiśnia jagoda jagoda kamczacka aronia mango marakuja ananas malina czerwona porzeczka',
  'Blend of young and aged lambics with cherries and bourbon vanilla.',
  'Peated Imperial Stout /peated whisky oak chips, sea salt & vanilla /',
  'IPA',
];

describe('isDescription', () => {
  test.each(LIVE_DESCRIPTIONS)('live description %# is a description', (text) => {
    expect(isDescription(text)).toBe(true);
  });

  test.each(LIVE_STYLES)('live style is not a description: %s', (text) => {
    expect(isDescription(text)).toBe(false);
  });

  test('a short text with a sentence break is a description (length alone would not catch it)', () => {
    expect(isDescription('Session IPA. Brewed with Citra hops')).toBe(true);
  });

  test('a sentence may end with ! or ?', () => {
    expect(isDescription('Fresh batch! Now on tap')).toBe(true);
    expect(isDescription('Thirsty? Try this one')).toBe(true);
  });

  test('a two-letter abbreviation before the period is not a sentence end', () => {
    expect(isDescription('Stout nr. Two')).toBe(false);
  });

  test('a period followed by a lowercase letter is not a sentence break', () => {
    expect(isDescription('Pale Ale approx. five hops')).toBe(false);
  });

  test('120 code points without a sentence break is a style; 121 is a description', () => {
    expect(isDescription('a'.repeat(120))).toBe(false);
    expect(isDescription('a'.repeat(121))).toBe(true);
  });

  test('length is counted in code points, not UTF-16 units', () => {
    expect(isDescription('😀'.repeat(120))).toBe(false);
    expect(isDescription('😀'.repeat(121))).toBe(true);
  });

  test('empty string is not a description', () => {
    expect(isDescription('')).toBe(false);
  });
});

describe('displayStyle', () => {
  const description = LIVE_DESCRIPTIONS[4];

  test('description + catalogue style → catalogue style', () => {
    expect(displayStyle(description, 'Stout - Irish Dry')).toBe('Stout - Irish Dry');
  });

  test('description + no catalogue style → null', () => {
    expect(displayStyle(description, null)).toBeNull();
  });

  test('plain style + catalogue style → the pub’s own style', () => {
    expect(displayStyle('NEIPA /Riwaka Cryo, Nelson Sauvin & Citra', 'IPA - New England / Hazy'))
      .toBe('NEIPA /Riwaka Cryo, Nelson Sauvin & Citra');
  });

  test('no tap style + catalogue style → null (the catalogue is not a general fallback)', () => {
    expect(displayStyle(null, 'IPA - American')).toBeNull();
  });
});
