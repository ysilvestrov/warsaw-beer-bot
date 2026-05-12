import { matchBeer, breweryAliases, type CatalogBeer } from './matcher';

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
