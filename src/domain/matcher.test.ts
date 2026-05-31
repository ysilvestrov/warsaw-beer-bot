import { matchBeer, breweryAliases, extractYear, type CatalogBeer } from './matcher';

const c = (over: Partial<CatalogBeer> & { id: number }): CatalogBeer => ({
  brewery: 'Pinta',
  name: 'Atak Chmielu',
  abv: null,
  ...over,
});

const catalog: CatalogBeer[] = [
  c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1 }),
  c({ id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta', abv: 5.0 }),
  c({ id: 3, brewery: 'Piwne Podziemie', name: 'Hopinka', abv: 6.0 }),
];

describe('breweryAliases', () => {
  test('plain brewery returns one alias', () => {
    expect(breweryAliases('Pinta')).toEqual(['pinta']);
  });

  test('drops noise words consistent with normalizeBrewery', () => {
    expect(breweryAliases('Piwne Podziemie Brewery')).toEqual(['piwne podziemie']);
  });

  test('slash form returns full + each half', () => {
    const out = breweryAliases('Piwne Podziemie / Beer Underground');
    expect(new Set(out)).toEqual(
      new Set(['piwne podziemie beer underground', 'piwne podziemie', 'beer underground']),
    );
  });

  test('paren form returns full + outer + inner', () => {
    const out = breweryAliases('Kemker Kultuur (Brauerei J. Kemker)');
    expect(new Set(out)).toEqual(
      new Set([
        'kemker kultuur brauerei j kemker',
        'kemker kultuur',
        'brauerei j kemker',
      ]),
    );
  });

  test('mixed slash + paren splits on both', () => {
    const out = breweryAliases('AleBrowar / Kemker Kultuur (Brauerei J. Kemker)');
    expect(new Set(out)).toEqual(
      new Set([
        'alebrowar kemker kultuur brauerei j kemker',
        'alebrowar',
        'kemker kultuur',
        'brauerei j kemker',
      ]),
    );
  });

  test('slash without spaces (Sady/Beer Bacon collab style) splits both halves', () => {
    const out = breweryAliases('Sady/Beer Bacon and Liberty Brewery');
    expect(new Set(out)).toEqual(
      new Set([
        'sady beer bacon and liberty',
        'sady',
        'beer bacon and liberty',
      ]),
    );
  });

  test('slash with right-side space only (Nieczajna/ Monsters style) splits both halves', () => {
    const out = breweryAliases('Nieczajna/ Monsters Brewery');
    expect(new Set(out)).toEqual(
      new Set(['nieczajna monsters', 'nieczajna', 'monsters']),
    );
  });

  test('slash with left-side space only (Stu Mostów /Ophiussa style) splits both halves', () => {
    const out = breweryAliases('Stu Mostów /Ophiussa Brewery');
    expect(new Set(out)).toEqual(
      new Set(['stu mostow ophiussa', 'stu mostow', 'ophiussa']),
    );
  });

  test('multi-slash collab (A/B/C) splits into all parts', () => {
    const out = breweryAliases('Nieczajna/Craftownia/Same Krafty Brewery');
    expect(new Set(out)).toEqual(
      new Set([
        'nieczajna craftownia same krafty',
        'nieczajna',
        'craftownia',
        'same krafty',
      ]),
    );
  });

  test('x-connector collab (lower case x) returns full + each side', () => {
    const out = breweryAliases('ZIEMIA OBIECANA x Weźże Krafta Brewery');
    expect(new Set(out)).toEqual(
      new Set(['ziemia obiecana x wezze krafta', 'ziemia obiecana', 'wezze krafta']),
    );
  });

  test('X-connector collab (upper case X) returns full + each side', () => {
    const out = breweryAliases('HOPITO X SADY Brewery');
    expect(new Set(out)).toEqual(
      new Set(['hopito x sady', 'hopito', 'sady']),
    );
  });

  test('&-connector collab returns full + each side', () => {
    const out = breweryAliases('Moon Lark & AleBrowar Brewery');
    expect(new Set(out)).toEqual(
      new Set(['moon lark alebrowar', 'moon lark', 'alebrowar']),
    );
  });

  test('empty input returns empty array', () => {
    expect(breweryAliases('')).toEqual([]);
  });
});

test('exact normalized match is confidence 1', () => {
  const m = matchBeer({ brewery: 'PINTA', name: 'Atak Chmielu IPA' }, catalog);
  expect(m).toEqual({ id: 1, confidence: 1, source: 'exact' });
});

test('fuzzy match above the lowered 0.75 threshold returns < 1 confidence', () => {
  const m = matchBeer({ brewery: 'Stu Mostow', name: 'Buty Skejty' }, catalog);
  expect(m?.id).toBe(2);
  expect(m!.confidence).toBeGreaterThanOrEqual(0.75);
  expect(m!.confidence).toBeLessThan(1);
});

test('no match below threshold returns null', () => {
  expect(matchBeer({ brewery: 'Random', name: 'Xyz' }, catalog)).toBeNull();
});

describe('matchBeer — slash-alias breweries', () => {
  test('exact: ontap "Piwne Podziemie Brewery" hits Untappd row "Piwne Podziemie / Beer Underground"', () => {
    const catalog: CatalogBeer[] = [
      { id: 8396, brewery: 'Piwne Podziemie / Beer Underground', name: 'Juicilicious', abv: 6.0 },
    ];
    const m = matchBeer(
      { brewery: 'Piwne Podziemie Brewery', name: 'Juicilicious', abv: 6.0 },
      catalog,
    );
    expect(m).toEqual({ id: 8396, confidence: 1, source: 'exact' });
  });

  test('exact: reverse direction also works', () => {
    const catalog: CatalogBeer[] = [
      { id: 1, brewery: 'Piwne Podziemie Brewery', name: 'X', abv: null },
    ];
    const m = matchBeer(
      { brewery: 'Piwne Podziemie / Beer Underground', name: 'X' },
      catalog,
    );
    expect(m?.id).toBe(1);
    expect(m?.source).toBe('exact');
  });

  test('exact: collab — ontap shows left brewery, Untappd has "A / B"', () => {
    const catalog: CatalogBeer[] = [
      { id: 42, brewery: 'AleBrowar / Poppels Bryggeri', name: 'Son Of The Son', abv: 8.0 },
    ];
    const m = matchBeer(
      { brewery: 'AleBrowar', name: 'Son Of The Son', abv: 8.0 },
      catalog,
    );
    expect(m).toEqual({ id: 42, confidence: 1, source: 'exact' });
  });

  test('exact: collab — ontap shows right brewery', () => {
    const catalog: CatalogBeer[] = [
      { id: 42, brewery: 'AleBrowar / Poppels Bryggeri', name: 'Son Of The Son', abv: 8.0 },
    ];
    const m = matchBeer(
      { brewery: 'Poppels Bryggeri Brewery', name: 'Son Of The Son', abv: 8.0 },
      catalog,
    );
    expect(m?.id).toBe(42);
    expect(m?.source).toBe('exact');
  });

  test('negative: brewery alias does not bridge unrelated names', () => {
    const catalog: CatalogBeer[] = [
      { id: 1, brewery: 'Piwne Podziemie / Beer Underground', name: 'Different Beer', abv: null },
    ];
    const m = matchBeer(
      { brewery: 'Piwne Podziemie Brewery', name: 'Juicilicious' },
      catalog,
    );
    // Name doesn't match; alias overlap alone is not enough.
    expect(m).toBeNull();
  });

  test('negative: completely different brewery — no alias overlap', () => {
    const catalog: CatalogBeer[] = [
      { id: 1, brewery: 'Piwne Podziemie / Beer Underground', name: 'Juicilicious', abv: null },
    ];
    const m = matchBeer(
      { brewery: 'Browar Stu Mostów', name: 'Juicilicious' },
      catalog,
    );
    expect(m).toBeNull();
  });
});

describe('matchBeer — bare-slash (insert-time prevention)', () => {
  test('ontap "Sady/Beer Bacon and Liberty Brewery Midnight Mass" hits canonical Untappd row "Browar Sady Midnight Mass"', () => {
    const canon: CatalogBeer[] = [
      c({ id: 100, brewery: 'Browar Sady', name: 'Midnight Mass', abv: 10.9 }),
    ];
    const m = matchBeer(
      { brewery: 'Sady/Beer Bacon and Liberty Brewery', name: 'Midnight Mass', abv: 10.9 },
      canon,
    );
    expect(m).toEqual({ id: 100, confidence: 1, source: 'exact' });
  });
});

describe('vintage handling', () => {
  const vintages: CatalogBeer[] = [
    c({ id: 10, brewery: 'Harpagan', name: 'Buzdygan Rozkoszy 2024', abv: 8.0 }),
    c({ id: 11, brewery: 'Harpagan', name: 'Buzdygan Rozkoszy 2025', abv: 8.5 }),
    c({ id: 12, brewery: 'Harpagan', name: 'Buzdygan Rozkoszy 2026', abv: 9.5 }),
  ];

  test('picks the latest vintage when ABV not provided', () => {
    const m = matchBeer({ brewery: 'Harpagan', name: 'Buzdygan Rozkoszy' }, vintages);
    expect(m?.id).toBe(12); // highest id = newest
    expect(m?.source).toBe('exact');
  });

  test('picks ABV-matching vintage when ABV provided', () => {
    const m = matchBeer(
      { brewery: 'Harpagan', name: 'Buzdygan Rozkoszy', abv: 8.5 },
      vintages,
    );
    expect(m?.id).toBe(11); // 2025 matches ABV 8.5
  });

  test('falls back to latest when no ABV in catalog matches input', () => {
    const m = matchBeer(
      { brewery: 'Harpagan', name: 'Buzdygan Rozkoszy', abv: 12.0 },
      vintages,
    );
    expect(m?.id).toBe(12); // none match — return latest anyway
  });

  test('ABV tolerance: 0.3 absolute', () => {
    const m = matchBeer(
      { brewery: 'Harpagan', name: 'Buzdygan Rozkoszy', abv: 8.7 },
      vintages,
    );
    expect(m?.id).toBe(11); // 8.5 within 0.3 of 8.7
  });

  test('ignores catalog ABV nulls when picking by ABV', () => {
    const mixed: CatalogBeer[] = [
      c({ id: 20, brewery: 'X', name: 'Foo', abv: null }),
      c({ id: 21, brewery: 'X', name: 'Foo', abv: 5.0 }),
    ];
    const m = matchBeer({ brewery: 'X', name: 'Foo', abv: 5.0 }, mixed);
    expect(m?.id).toBe(21);
  });
});

test('ontap-style raw beer_ref + ABV maps to clean Untappd entry', () => {
  // Real-world scenario from issue #18: ontap parser used to leave
  // "Buzdygan Rozkoszy 24°·8,5% — Caribbean Imperial Stout" in beer_ref,
  // but with the fix beer_ref is clean.
  const m = matchBeer(
    { brewery: 'Harpagan Brewery', name: 'Buzdygan Rozkoszy', abv: 8.5 },
    [c({ id: 99, brewery: 'Harpagan', name: 'Buzdygan Rozkoszy', abv: 8.5 })],
  );
  expect(m?.id).toBe(99);
});

describe('extractYear', () => {
  test('finds 4-digit year in parentheses', () => {
    expect(extractYear('Affection (2025)')).toBe(2025);
  });
  test('finds bare 4-digit year', () => {
    expect(extractYear('AFFECTION 2023')).toBe(2023);
  });
  test('returns null when no 4-digit year present', () => {
    expect(extractYear('Affection')).toBeNull();
  });
  test('ignores abbreviated 2-digit year form', () => {
    expect(extractYear("Farm to Glass '25: Citra")).toBeNull();
  });
  test('1900-range year is detected', () => {
    expect(extractYear('Vintage 1998')).toBe(1998);
  });
  test('number outside 19xx/20xx range is not a year', () => {
    expect(extractYear('Tripel 888')).toBeNull();
  });
});

describe('matchBeer — vintage year disambiguation', () => {
  const pinta = (id: number, name: string, abv: number | null): CatalogBeer =>
    ({ id, name, brewery: 'PINTA Barrel Brewing', abv });

  test('year match + ABV ok → returns yearMatch candidate', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
      pinta(8,  'Affection',        7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(10);
    expect(m?.source).toBe('exact');
  });

  test('year match + ABV mismatch → noYear ABV hit wins', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 9.9),
      pinta(8,  'Affection',        7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(8);
  });

  test('year match + ABV mismatch + no noYear → wrongYear ABV hit wins (most recent)', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 9.9),
      pinta(9,  'Affection (2024)', 7.0),
      pinta(7,  'Affection (2022)', 7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(9);
  });

  test('year match + ABV mismatch + no alternatives → accept ABV error, return yearMatch', () => {
    const catalog = [pinta(10, 'Affection (2025)', 9.9)];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025', abv: 7.0 }, catalog);
    expect(m?.id).toBe(10);
  });

  test('year match + no input ABV → returns yearMatch without ABV check', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 9.9),
      pinta(8,  'Affection',        7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2025' }, catalog);
    expect(m?.id).toBe(10);
  });

  test('no same-year entry → noYear fallback, ABV applied', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
      pinta(8,  'Affection',        7.0),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2023', abv: 7.0 }, catalog);
    expect(m?.id).toBe(8);
  });

  test('no same-year entry → noYear fallback, most-recent when no ABV', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
      pinta(8,  'Affection',        7.0),
      pinta(6,  'Affection',        6.5),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2023' }, catalog);
    expect(m?.id).toBe(8);
  });

  test('only wrong-year candidates → null (no cross-vintage match)', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 7.1),
      pinta(9,  'Affection (2024)', 6.8),
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection 2023', abv: 7.0 }, catalog);
    expect(m).toBeNull();
  });

  test('no year in input → existing behavior (ABV then most-recent)', () => {
    const catalog = [
      pinta(10, 'Affection (2025)', 8.5),  // outside 0.3 tolerance of 6.8
      pinta(9,  'Affection (2024)', 6.8),  // exact ABV match
    ];
    const m = matchBeer({ brewery: 'PINTA Barrel Brewing', name: 'Affection', abv: 6.8 }, catalog);
    expect(m?.id).toBe(9);
  });
});
