import {
  isOntapNonBeerTap, ontapTapExclusion, ELIGIBLE_TOKENS,
  classifyOrphanAsNonBeer, NON_BEER_NAME_TOKENS, type OrphanBoundaryInput,
} from './drink-boundary';

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
    ['style wine grapes glera', { style: 'Chardonnay, Glera and Garganega', brewery_ref: 'Cantina della Valle', beer_ref: 'Vino Bianco Frizzante' }],
    ['brewery aperitivo with suffix', { style: null, brewery_ref: 'Aperitivo Spritz Brewery', beer_ref: 'Aperol Spritz' }],
    ['brewery cantina singular', { style: null, brewery_ref: 'Cantina della Valle Brewery', beer_ref: 'Glera Trevenezie' }],
    ['brewery cantina no suffix', { style: null, brewery_ref: 'Cantina della Valle', beer_ref: 'Vino Bianco Frizzante' }],
    ['schedule pollution brewery', { style: null, brewery_ref: 'Basement -> Czwartek-Sobota od 18.00 Brewery', beer_ref: 'Bar' }],
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
    ['kombucha style (#430 moved from flagged to eligible)', { style: 'Kombucha', brewery_ref: 'Koko Kombucha Brewery', beer_ref: 'Imbir' }],
    ['kombucha brewery null style (#430 moved from flagged to eligible)', { style: null, brewery_ref: 'Koko Kombucha Brewery', beer_ref: 'Imbir' }],
    ['normal beer', { style: 'West Coast IPA', brewery_ref: 'PINTA Brewery' }],
    ['similar service-themed beer name', { style: 'IPA', brewery_ref: 'PINTA Brewery', beer_ref: 'Kran w serwisie najlepszych piw' }],
    ['normal brewery with dash but no arrow/time', { style: 'IPA', brewery_ref: 'Browar Stu Mostow - Wroclaw' }],
    ['drinkability prose does not match generic drink', {
      style: 'Dark, smooth, and deceptively light on the palate, endlessly drinkable Schwarzbier',
      brewery_ref: 'FUERST WIACEK Berlin Brewery',
    }],
  ])('keeps %s eligible', (_label, tap) => {
    expect(isOntapNonBeerTap(tap)).toBe(false);
  });

  test('does not apply non-beer metadata tokens to beer_ref/name', () => {
    const tapWithName = {
      style: null,
      brewery_ref: 'Beer Brewery',
      beer_ref: 'Vino Merlot Spritz Prosecco',
    };
    expect(isOntapNonBeerTap(tapWithName)).toBe(false);
  });
});

describe('ontapTapExclusion', () => {
  test.each([
    ['out-of-stock beer_ref', { style: null, brewery_ref: '- Brewery', beer_ref: 'Guinness Chwilowy brak:(' }],
    ['bare out-of-stock', { style: null, brewery_ref: '- Brewery', beer_ref: 'Chwilowy Brak:(' }],
    ['drunk-up placeholder', { style: null, brewery_ref: 'Chwilowy Brak:( Brewery', beer_ref: 'Wypite' }],
    ['tap out of service', { style: null, brewery_ref: 'Kran czeka na lepsze czasy Brewery', beer_ref: 'KRAN W SERWISIE' }],
  ])('classifies %s as a placeholder', (_label, tap) => {
    expect(ontapTapExclusion(tap)).toBe('placeholder');
  });

  test('classifies wine as non-beer', () => {
    expect(ontapTapExclusion({ style: 'PROSECCO', brewery_ref: 'Cantine Vitevis' })).toBe('non-beer');
  });

  test('returns null for a real beer', () => {
    expect(ontapTapExclusion({ style: 'IPA', brewery_ref: 'Pinta Brewery', beer_ref: 'Atak Chmielu' }))
      .toBeNull();
  });

  test('keeps a real beer whose name merely contains a brand called Wypite-like word', () => {
    expect(ontapTapExclusion({ style: 'Lager', brewery_ref: 'Browar Kormoran', beer_ref: 'Kormoran Miodne' }))
      .toBeNull();
  });

  test.each([
    ['kofola with suffix', { style: 'Soft Drink', brewery_ref: 'Kofola Brewery', beer_ref: 'Kofola' }],
    ['kofola long brewery', { style: 'napój bezalkoholowy', brewery_ref: 'Kofola Československo Brewery', beer_ref: 'Kofola' }],
    ['mojito sentinel with suffix', { style: 'Bezalkoholowe', brewery_ref: 'Mojito Brewery', beer_ref: 'Mojito' }],
  ])('classifies %s as non-beer', (_label, tap) => {
    expect(ontapTapExclusion(tap)).toBe('non-beer');
  });

  test('non-alcoholic BEER is not excluded', () => {
    expect(ontapTapExclusion({ style: 'Bezalkoholowe', brewery_ref: 'TRZECH KUMPLI Brewery', beer_ref: 'PAN IPANI BEZALKOHOLOWE 8°' })).toBeNull();
    expect(ontapTapExclusion({ style: 'Non-alcoholic lager', brewery_ref: 'Funky Fluid Brewery', beer_ref: 'Free' })).toBeNull();
  });

  test('a single-word placeholder only matches the whole value', () => {
    expect(ontapTapExclusion({ style: null, brewery_ref: 'Chwilowy Brak:( Brewery', beer_ref: 'Wypite' }))
      .toBe('placeholder');
    expect(ontapTapExclusion({ style: 'Sour Ale', brewery_ref: 'Piwne Podziemie Brewery', beer_ref: 'Wypite Marzenia' }))
      .toBeNull();
  });
});

// The 14 real tap rows behind the not_a_beer orphans, replayed 2026-08-22.
// `expected` is the verdict this task must produce.
const LEAKED_TAPS: { brewery_ref: string | null; beer_ref: string; style: string | null;
                     expected: 'non-beer' | 'placeholder' | null }[] = [
  // Eligible drinks the filter already keeps, and MUST keep.
  { brewery_ref: 'Cydr Smykan', beer_ref: 'Kwaśny Zdzichu', style: 'Cydr wytrawny z czarną porzeczką', expected: null },
  { brewery_ref: 'Dzik', beer_ref: 'Cydr Perry', style: 'Polslodki Gruszkowy', expected: null },
  { brewery_ref: 'Jabłecznik Trzebnicki', beer_ref: 'Cydr tradycyjny', style: 'Cydr półwytrawny', expected: null },
  { brewery_ref: 'Chyliczki', beer_ref: 'Cydr Chyliczki - Japoński Sad', style: 'Wytrawny i naturalnie musujący', expected: null },
  { brewery_ref: 'Flirt', beer_ref: 'BLOOD ORANGE', style: 'Cydr', expected: null },
  { brewery_ref: 'Tradycinis', beer_ref: 'Borówka z miętą', style: 'Cydr', expected: null },
  // The five gaps this task closes.
  { brewery_ref: 'VINO KARPATIA', beer_ref: 'Biały bez', style: null, expected: 'non-beer' },
  { brewery_ref: 'Sangria', beer_ref: 'Sangria Czerwona', style: null, expected: 'non-beer' },
  { brewery_ref: 'Bianco Frizzante', beer_ref: 'Frizzante Bianco', style: null, expected: 'non-beer' },
  { brewery_ref: 'Ima Distillery Brewery', beer_ref: 'Stefanówka z Pyrów', style: 'Wódka ziemniaczana', expected: 'non-beer' },
  { brewery_ref: 'takie zero. takie nic. Brewery', beer_ref: 'KRAN PUSTY. dużo°·21,37%', style: '67 VEGETARIAN PROGRESSIVE IMPERIAL BASS BOOSTED PORTER LEWOSKRETNY', expected: 'placeholder' },
  // Deliberately still leaking — a name-side test at ingest is forbidden (see Global
  // Constraints). Task 4's post-search enforcer is what covers these. Asserted so that a
  // later change which catches them here is a visible decision, not a silent drift.
  { brewery_ref: 'Culaccino', beer_ref: 'Aperol Spritz', style: null, expected: null },
  { brewery_ref: 'Monte Santi', beer_ref: 'Hugo Spritz', style: null, expected: null },
  { brewery_ref: null, beer_ref: 'N/A', style: null, expected: null },
];

describe('ontapTapExclusion against the measured leak set', () => {
  for (const t of LEAKED_TAPS) {
    it(`${t.brewery_ref ?? '(null)'} / ${t.beer_ref} -> ${t.expected ?? 'kept'}`, () => {
      expect(ontapTapExclusion(t)).toBe(t.expected);
    });
  }
});

describe('kombucha is an eligible drink family', () => {
  it('is listed as eligible', () => {
    expect(ELIGIBLE_TOKENS).toContain('kombucha');
  });

  it('keeps a hard kombucha tap — Untappd carries Hard Kombucha / Jun', () => {
    expect(ontapTapExclusion({
      brewery_ref: 'LOBSTER Brewery', beer_ref: 'Kombucha Calamansi', style: 'Kombucha',
    })).toBeNull();
  });
});

describe('#430 narrowing: vodka is an exact-phrase style match, not a substring', () => {
  it('keeps a vodka-barrel-aged beer whose style merely mentions vodka', () => {
    expect(ontapTapExclusion({
      style: 'Imperial Stout (Vodka BA)', brewery_ref: 'Some Brewery', beer_ref: 'BA Stout',
    })).toBeNull();
  });
});

const orphan = (over: Partial<OrphanBoundaryInput> = {}): OrphanBoundaryInput => ({
  brewery: '', name: '', style: null, candidates_count: 0, ...over,
});

describe('classifyOrphanAsNonBeer catches the rows the ingest filter must not guess at', () => {
  it('catches a bare Spritz name', () => {
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'Culaccino', name: 'Aperol Spritz' })))
      .toEqual({ nonBeer: true, token: 'spritz' });
  });

  it('catches a Hugo Spritz', () => {
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'Monte Santi', name: 'Hugo Spritz' })))
      .toEqual({ nonBeer: true, token: 'spritz' });
  });
});

describe('the three necessary conditions', () => {
  it('declines when Untappd returned candidates — the model decides those', () => {
    expect(classifyOrphanAsNonBeer(
      orphan({ brewery: 'Culaccino', name: 'Aperol Spritz', candidates_count: 3 }),
    )).toBeNull();
  });

  it('declines when an eligible family is named anywhere on the row', () => {
    expect(classifyOrphanAsNonBeer(
      orphan({ brewery: 'Cydr Dzik', name: 'Spritz Cydr', style: 'Cydr' }),
    )).toBeNull();
  });

  it('matches on a word boundary, never a substring', () => {
    // "spritzer" is not "spritz"; if this passes as a substring the rule is unsafe.
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'X', name: 'Spritzered Ale' }))).toBeNull();
  });
});

describe('false positives drawn from beers we have ALREADY matched', () => {
  // Every one of these is a real style/name family from our own catalogue: 268 matched
  // beers carry wine/wino/vino, 257 carry a food word. If any of them classifies, the
  // rule is destroying live beers.
  const realBeers = [
    { brewery: 'Dwinell Country Ales', name: 'Field Guide' },
    { brewery: 'Vinohradský pivovar', name: 'Vinohradská 12' },
    { brewery: 'Anonymous', name: 'Barley Wine 2021' },
    { brewery: 'Anonymous', name: 'Bourbon Barrel Aged Wine Cask Stout' },
    { brewery: 'Anonymous', name: 'Sausage Fingers' },
    { brewery: 'Anonymous', name: 'Birthday Cake Pastry Stout' },
    { brewery: 'LOBSTER Brewery', name: 'Kombucha Calamansi' },
    { brewery: 'Hidden Legend Winery', name: 'Wild Elderberry Mead' },
  ];
  for (const b of realBeers) {
    it(`keeps ${b.brewery} / ${b.name}`, () => {
      expect(classifyOrphanAsNonBeer(orphan(b))).toBeNull();
    });
  }
});

describe('NON_BEER_NAME_TOKENS is narrower than the ingest lists on purpose', () => {
  it('never contains a bare wine token', () => {
    for (const unsafe of ['wine', 'wino', 'vino']) {
      expect(NON_BEER_NAME_TOKENS).not.toContain(unsafe);
    }
  });
});
