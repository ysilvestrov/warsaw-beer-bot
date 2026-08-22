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
    ['schedule pollution brewery', { style: null, brewery_ref: 'Basement -> Czwartek-Sobota od 18.00 Brewery', beer_ref: 'Bar' }],
  ])('flags %s', (_label, tap) => {
    expect(isOntapNonBeerTap(tap)).toBe(true);
  });

  // 2026-08-22: 'brewery cantina singular'/'brewery cantina no suffix' (asserting
  // 'Cantina della Valle' is flagged via the 'cantina' token) deleted here, not
  // renamed to a different fictional cantina. A producer's NAME cannot distinguish an
  // Italian wine cellar from an Italian brewery that calls itself one: 'Cantina
  // Errante' makes Grape Ale, Wild Ale and Flanders Oud Bruin (9 matched beers) and
  // nothing in the string tells it apart from a wine-only 'Cantina della Valle'. So
  // 'cantina' was not a badly-written token — it was an unanswerable one, and the
  // module's governing asymmetry decides unanswerable cases toward eligible: a false
  // "eligible" costs one Untappd search, a false drop at ingest is silent and
  // permanent (#306). This test documents the accepted leak instead of quietly
  // dropping coverage: a wine-cellar-named brewery now surfaces as a visible orphan
  // (for the model or a human to judge) rather than vanishing at ingest.
  it('leaks a wine-cellar-named brewery like Cantina della Valle — no token distinguishes it from Cantina Errante (9 matched beers)', () => {
    expect(isOntapNonBeerTap({ style: null, brewery_ref: 'Cantina della Valle', beer_ref: 'Glera Trevenezie' })).toBe(false);
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

// 2026-08-22: BREWERY_TOKENS validated against all 3465 distinct matched breweries in
// the production catalogue. Both real breweries below were being dropped at ingest —
// silently and permanently, since a dropped tap never reaches the post-search
// enforcer (#306). Regression fixtures so neither collision is reintroduced.
describe('#430 Critical: BREWERY_TOKENS must not collide with real matched breweries', () => {
  it('keeps Vinohradský pivovar — 6 matched beers (Pilsner - Czech / Bohemian, IPA - Session NE); "vino" only collided as a substring inside the name', () => {
    expect(ontapTapExclusion({
      brewery_ref: 'Vinohradský pivovar', beer_ref: 'Hazy Galaxy', style: null,
    })).toBeNull();
  });

  it('keeps Cantina Errante — 9 matched beers (Grape Ale - Italian, Wild Ale - Other, Sour - Flanders Oud Bruin, Farmhouse Ale - Bière de Coupage); "cantina" is removed from BREWERY_TOKENS entirely', () => {
    expect(ontapTapExclusion({
      brewery_ref: 'Cantina Errante', beer_ref: 'Nifunifa 2023', style: null,
    })).toBeNull();
  });
});

// Critical B (final whole-branch review, 2026-08-22): real rows from our OWN matched
// catalogue, replayed through isOntapNonBeerTap with style=null (the measured common
// case — 64/83 rows). Before the fix all three came back 'non-beer': the eligible
// short-circuit tested `style` alone, so a cider/mead named only in brewery_ref/
// beer_ref was invisible to it, and the producer's name happens to trip the brewery
// wine-family checks. A real drink was being dropped at ingest — permanently, since a
// dropped tap never reaches the post-search enforcer at all.
describe('#430 Critical B: the eligible short-circuit must see brewery_ref/beer_ref, not just style', () => {
  const CATALOGUE_LEAKS: { brewery_ref: string; beer_ref: string; trueStyle: string }[] = [
    { brewery_ref: 'WINE BOYZ BAND & SPOKO', beer_ref: 'Spoko Cydr Zweigelt Edition', trueStyle: 'Cider - Dry' },
    { brewery_ref: 'Hidden Legend Winery', beer_ref: 'Wild Elderberry Mead', trueStyle: 'Mead - Melomel' },
    { brewery_ref: 'Gut Wine', beer_ref: 'Nekyvana Kachka', trueStyle: 'Cider - Dry' },
  ];
  for (const row of CATALOGUE_LEAKS) {
    it(`keeps ${row.brewery_ref} / ${row.beer_ref} (really ${row.trueStyle}) eligible with style=null`, () => {
      expect(isOntapNonBeerTap({ style: null, brewery_ref: row.brewery_ref, beer_ref: row.beer_ref })).toBe(false);
      expect(ontapTapExclusion({ style: null, brewery_ref: row.brewery_ref, beer_ref: row.beer_ref })).toBeNull();
    });
  }

  // Isolates the eligible-broadening change from the BREWERY_TOKENS narrowing next to
  // it: 'vino' stays a brewery trigger (VINO KARPATIA above needs it), so this row
  // would still be wrongly flagged today if the eligible check only looked at style —
  // it is rescued ONLY because the check now also reads beer_ref.
  it('rescues a real cider sold by a brewery whose name still trips a kept brewery token', () => {
    expect(isOntapNonBeerTap({ style: null, brewery_ref: 'VINO KARPATIA', beer_ref: 'Cydr wiśniowy' })).toBe(false);
  });

  it('still flags the same brewery when the name gives no eligible signal (unchanged verdict)', () => {
    // Companion to the row above: proves the rescue is about the NAME, not about
    // VINO KARPATIA having stopped being a brewery-side trigger.
    expect(isOntapNonBeerTap({ style: null, brewery_ref: 'VINO KARPATIA', beer_ref: 'Biały bez' })).toBe(true);
  });
});

const orphan = (over: Partial<OrphanBoundaryInput> = {}): OrphanBoundaryInput => ({
  brewery: '', name: '', style: null, candidates_count: 0, ...over,
});

describe('classifyOrphanAsNonBeer catches the rows the ingest filter must not guess at', () => {
  it('catches a bare Spritz name', () => {
    // "spritz" itself was removed by the collision measurement (9 real beers); this row
    // is still caught because "Aperol" survives as a zero-collision token.
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'Culaccino', name: 'Aperol Spritz' })))
      .toEqual({ nonBeer: true, token: 'aperol' });
  });

  // Deliberately the cheap-direction leak: no surviving token appears in "Hugo Spritz",
  // so this row is NOT caught post-search. Missing an orphan costs one un-triaged row;
  // wrongly sealing a real beer is permanent — the asymmetry the whole module is built on.
  it('leaks a bare Hugo Spritz — no token survives the collision measurement', () => {
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'Monte Santi', name: 'Hugo Spritz' })))
      .toBeNull();
  });
});

describe('the three necessary conditions', () => {
  it('declines when Untappd returned candidates — the model decides those', () => {
    expect(classifyOrphanAsNonBeer(
      orphan({ brewery: 'Culaccino', name: 'Aperol Spritz', candidates_count: 3 }),
    )).toBeNull();
  });

  it('declines when an eligible family is named anywhere on the row', () => {
    // Uses a surviving token ("nalewka") alongside an eligible one ("cydr") so this test
    // still proves condition 2: with "spritz" gone, a row built on "spritz" would return
    // null regardless of the ELIGIBLE_TOKENS guard and the mutation proof would be vacuous.
    expect(classifyOrphanAsNonBeer(
      orphan({ brewery: 'Cydr Smykan', name: 'Nalewka Cydr', style: 'Cydr' }),
    )).toBeNull();
  });

  it('matches on a word boundary, never a substring', () => {
    // "nalewkarnia" is not "nalewka"; if this passes as a substring the rule is unsafe.
    // Uses a surviving token so the assertion still exercises the word-set check.
    expect(classifyOrphanAsNonBeer(orphan({ brewery: 'X', name: 'Nalewkarnia Ale' }))).toBeNull();
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

  // Measured word-boundary against all 31224 matched beers in production (name + style):
  // spritz 9 (e.g. "Sicilian Spritz"), mojito 8 ("Emerald Mojito Gose"), vodka 4 ("Tatanka
  // Vodka Edition"), aperitivo 3 ("Aperitivo Stout"), sangria 3 ("Mystic Sangria"),
  // prosecco 1, frizzante 1. Re-adding any of these without a fresh zero-collision
  // measurement re-opens that leak. #430.
  it('never re-adds a token proven to collide with a real matched beer', () => {
    for (const proven of ['spritz', 'mojito', 'vodka', 'aperitivo', 'sangria', 'prosecco', 'frizzante']) {
      expect(NON_BEER_NAME_TOKENS).not.toContain(proven);
    }
  });
});
