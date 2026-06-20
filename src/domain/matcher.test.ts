import { vi } from 'vitest';
import { matchBeer, breweryAliases, breweryAliasesMatch, breweryAliasContained, extractYear, prepareCatalog, matchPrepared, prepareBeer, nameTokensDiverge, nameKeys, intersects, stripBreweryFromName, leadingRun, type CatalogBeer } from './matcher';

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
        'kemker kultuur j kemker',
        'kemker kultuur',
        'j kemker',
      ]),
    );
  });

  test('mixed slash + paren splits on both', () => {
    const out = breweryAliases('AleBrowar / Kemker Kultuur (Brauerei J. Kemker)');
    expect(new Set(out)).toEqual(
      new Set([
        'alebrowar kemker kultuur j kemker',
        'alebrowar',
        'kemker kultuur',
        'j kemker',
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

describe('decimal release identifiers', () => {
  const releases: CatalogBeer[] = [
    c({ id: 11185, brewery: 'FUNKY FLUID', name: 'Ambrosia 8.0', abv: 6.5 }),
    c({ id: 10615, brewery: 'FUNKY FLUID', name: 'Ambrosia 7.0', abv: 6.7 }),
    c({ id: 9859, brewery: 'FUNKY FLUID', name: 'Ambrosia 2025', abv: 6.5 }),
    c({ id: 387, brewery: 'FUNKY FLUID', name: 'Ambrosia 5.0', abv: 6.8 }),
  ];

  test('does not match an unknown release to an older catalog row without ABV', () => {
    expect(matchBeer({ brewery: 'FUNKY FLUID', name: 'Ambrosia 9.0' }, releases)).toBeNull();
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

test('brewery hard-gate: Czech Pivovar prefix overlaps tap label', () => {
  const tap = new Set(breweryAliases('Cerna Hora Brewery'));
  const untappd = breweryAliases('Pivovar Černá Hora');
  expect(untappd.some((a) => tap.has(a))).toBe(true);
});

describe('breweryAliasesMatch (token-boundary prefix)', () => {
  test('shorter token list is a leading prefix of the longer', () => {
    expect(breweryAliasesMatch(['harpagan'], ['harpagan contracts'])).toBe(true);
    expect(breweryAliasesMatch(['harpagan'], ['harpagan craft beer'])).toBe(true);
    expect(breweryAliasesMatch(['harpagan contracts'], ['harpagan'])).toBe(true);
  });

  test('exact equality still matches', () => {
    expect(breweryAliasesMatch(['pinta'], ['pinta'])).toBe(true);
  });

  test('mid-token prefixes do NOT match (Harp vs Harpagan)', () => {
    expect(breweryAliasesMatch(['harp'], ['harpagan'])).toBe(false);
  });

  test('non-leading shared token does NOT match (Project vs Side Project)', () => {
    expect(breweryAliasesMatch(['project'], ['side project'])).toBe(false);
  });

  test('disjoint breweries do not match', () => {
    expect(breweryAliasesMatch(['pinta'], ['stu mostow'])).toBe(false);
  });
});

describe('breweryAliasContained', () => {
  test('trailing token matches (#120 Staropolski)', () => {
    expect(breweryAliasContained(['kultowy staropolski'], ['staropolski'])).toBe(true);
  });
  test('leading prefix is also a contiguous sublist (in lookupBeer such a brewery is strict, not relaxed)', () => {
    expect(breweryAliasContained(['harpagan craft'], ['harpagan'])).toBe(true);
  });
  test('contiguous middle run matches', () => {
    expect(breweryAliasContained(['pure project park brewing'], ['project park'])).toBe(true);
  });
  test('non-contiguous tokens do not match', () => {
    expect(breweryAliasContained(['pure project park'], ['pure park'])).toBe(false);
  });
  test('unrelated breweries do not match', () => {
    expect(breweryAliasContained(['stu mostow'], ['pinta'])).toBe(false);
  });
  test('exact equality counts as contained', () => {
    expect(breweryAliasContained(['staropolski'], ['staropolski'])).toBe(true);
  });
  test('empty-string alias never matches', () => {
    expect(breweryAliasContained(['kultowy staropolski'], [''])).toBe(false);
  });
  test('empty alias list never matches', () => {
    expect(breweryAliasContained([], ['staropolski'])).toBe(false);
  });
});

describe('leadingRun', () => {
  test('full brewery at front of title is a leading run', () => {
    expect(leadingRun('pastry mastery schwarzbrot', 'pastry mastery')).toBe(true);
  });
  test('whole-string equality is a leading run', () => {
    expect(leadingRun('pastry mastery', 'pastry mastery')).toBe(true);
  });
  test('non-leading occurrence is not a run', () => {
    expect(leadingRun('pastry mastery schwarzbrot', 'mastery')).toBe(false);
  });
  test('partial token never matches (boundary)', () => {
    expect(leadingRun('pastry mastery', 'past')).toBe(false);
  });
  test('prefix longer than haystack is false', () => {
    expect(leadingRun('pastry mastery', 'pastry mastery schwarzbrot')).toBe(false);
  });
  test('empty operands are false', () => {
    expect(leadingRun('schwarzbrot', '')).toBe(false);
    expect(leadingRun('', 'schwarzbrot')).toBe(false);
  });
});

describe('matchBeer with official-suffix brewery', () => {
  test('matches ontap brand-only brewery to catalog official-suffix brewery', () => {
    const cat: CatalogBeer[] = [
      c({ id: 42, brewery: 'Harpagan Contracts', name: 'Buzdygan Rozkoszy', abv: 8.5 }),
    ];
    const result = matchBeer(
      { brewery: 'Harpagan Brewery', name: 'Buzdygan Rozkoszy', abv: 8.5 },
      cat,
    );
    expect(result).toEqual({ id: 42, confidence: 1, source: 'exact' });
  });
});

describe('prepareBeer', () => {
  it('precomputes nameNorm, breweryNorm and aliases', () => {
    const p = prepareBeer({ id: 7, brewery: 'Piwne Podziemie Brewery', name: 'Hopinka IPA', abv: 6 });
    expect(p.id).toBe(7);
    expect(p.nameNorm).toBe('hopinka');            // STYLE_WORD "ipa" stripped
    expect(p.breweryNorm).toBe('piwne podziemie');  // noise word "brewery" stripped
    expect(p.aliases).toEqual(['piwne podziemie']);
  });
});

describe('prepareCatalog — lazy/memoized fullSearcher', () => {
  const cat: CatalogBeer[] = [
    c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1 }),
    c({ id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta', abv: 5.0 }),
  ];

  it('does not build any Searcher when every beer matches exactly', () => {
    const build = vi.fn((rows) => prepareCatalog(rows).searcherFor(rows));
    const prepared = prepareCatalog(cat, build);
    matchPrepared({ brewery: 'Pinta', name: 'Atak Chmielu' }, prepared);
    expect(build).not.toHaveBeenCalled();
  });

  it('builds the full-catalog Searcher at most once across empty-pool fallbacks', () => {
    const build = vi.fn((rows) => prepareCatalog(rows).searcherFor(rows));
    const prepared = prepareCatalog(cat, build);
    // Two unknown breweries → empty pool → full-catalog fallback, twice.
    matchPrepared({ brewery: 'Nowhere', name: 'Mystery One' }, prepared);
    matchPrepared({ brewery: 'Elsewhere', name: 'Mystery Two' }, prepared);
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe('prepareCatalog — breweryCandidates index', () => {
  // A catalog with several first-token collisions and collab/paren aliases so the
  // first-token bucket holds a mix of true matches and same-prefix near-misses.
  const cat: CatalogBeer[] = [
    c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu' }),
    c({ id: 2, brewery: 'Pinta Barrel', name: 'Koniec Świata' }),
    c({ id: 3, brewery: 'Pinto', name: 'Different Brewery' }),
    c({ id: 4, brewery: 'Stu Mostów', name: 'Buty Skejta' }),
    c({ id: 5, brewery: 'Piwne Podziemie / Beer Underground', name: 'Hopinka' }),
    c({ id: 6, brewery: 'Beer Bros', name: 'Lager' }),
  ];
  const prepared = prepareCatalog(cat);

  // The index must return exactly the rows a full linear breweryAliasesMatch scan
  // would — set equality, regardless of order. This is the invariant that lets the
  // index replace the O(catalog) per-beer filter without changing any match result.
  const fullScan = (brewery: string) => {
    const ia = breweryAliases(brewery);
    return cat
      .map(prepareBeer)
      .filter((c) => breweryAliasesMatch(c.aliases, ia))
      .map((c) => c.id)
      .sort();
  };
  const indexed = (brewery: string) =>
    prepared
      .breweryCandidates(breweryAliases(brewery))
      .map((c) => c.id)
      .sort();

  test.each([
    'Pinta',                                  // token-prefix matches 'Pinta' + 'Pinta Barrel', not 'Pinto'
    'Pinta Barrel',
    'Pinto',
    'Beer Underground',                       // matches the collab inner alias of id 5
    'Piwne Podziemie / Beer Underground',
    'Beer Bros',
    'Nowhere',                                // no bucket → empty
  ])('matches the full-scan result set for %s', (brewery) => {
    expect(indexed(brewery)).toEqual(fullScan(brewery));
  });

  test('returns no duplicate rows when a row has multiple same-first-token aliases', () => {
    const ids = prepared.breweryCandidates(breweryAliases('Pinta')).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('nameTokensDiverge', () => {
  test('diverges on different flavour variants', () => {
    expect(nameTokensDiverge('vanilla mind over matter', 's mores mind over matter')).toBe(true);
  });
  test('tolerates a Polish inflection (skejty vs skejta)', () => {
    expect(nameTokensDiverge('buty skejty', 'buty skejta')).toBe(false);
  });
  test('tolerates a typo (chmiel vs chmielu)', () => {
    expect(nameTokensDiverge('atak chmiel', 'atak chmielu')).toBe(false);
  });
  test('subset names do not diverge, either direction', () => {
    expect(nameTokensDiverge('clementine passionfruit', 'clementine')).toBe(false);
    expect(nameTokensDiverge('clementine', 'clementine passionfruit')).toBe(false);
  });
  test('equal names do not diverge', () => {
    expect(nameTokensDiverge('atak chmielu', 'atak chmielu')).toBe(false);
  });
  test('ignores sub-2-char fragments', () => {
    expect(nameTokensDiverge('s mores', 'mores')).toBe(false);
  });
  test('empty / one-sided names never diverge', () => {
    expect(nameTokensDiverge('', '')).toBe(false);
    expect(nameTokensDiverge('', 'mind over matter')).toBe(false);
    expect(nameTokensDiverge('mind over matter', '')).toBe(false);
  });
});

describe('matchBeer — divergence guard', () => {
  test('rejects a different flavour variant with no exact entry', () => {
    const cat = [c({ id: 50, brewery: 'Magnify Brewing Company', name: "S'mores Mind Over Matter" })];
    expect(matchBeer({ brewery: 'Magnify', name: 'Double Vanilla Mind Over Matter' }, cat)).toBeNull();
  });
  test('still matches when the input name is a subset of the candidate', () => {
    const cat = [c({ id: 51, brewery: 'Magnify', name: 'Mind Over Matter' })];
    expect(matchBeer({ brewery: 'Magnify', name: 'Vanilla Mind Over Matter' }, cat)?.id).toBe(51);
  });
});

describe('nameKeys (#117)', () => {
  test('order-insensitive: reordered tokens produce the same key', () => {
    expect(nameKeys('TAP04 FESTWEISSE', 'Schneider'))
      .toEqual(nameKeys('Festweisse (TAP04)', 'Schneider Weisse'));
  });
  test('collab split: each "/"-side is its own key', () => {
    expect([...nameKeys('Fast Talking / North Park', 'Root + Branch')])
      .toEqual(expect.arrayContaining(['fast talking', 'north park']));
  });
  test('multi-token guard: single-token sides are dropped', () => {
    // "Finback" (1 token) dropped; "Globe Coagulant" (2) kept and sorted
    expect([...nameKeys('Globe Coagulant / Finback', 'Messorem')]).toEqual(['coagulant globe']);
  });
  test('single-token whole name → empty key set (falls through to fuzzy)', () => {
    expect(nameKeys('Kanelbullar', 'Omnipollo').size).toBe(0);
  });
  test('strips brewery duplicated into the name', () => {
    expect([...nameKeys('PRIMÁTOR FREE MOTHER IN LAW', 'Primator')]).toEqual(['free in law mother']);
  });
  test('bilingual canonical: English side matches the deduped input', () => {
    const input = nameKeys('PRIMÁTOR FREE MOTHER IN LAW', 'Primator');
    const canon = nameKeys('Free Tchyně / Free Mother In Law', 'Primátor');
    expect([...input].some((k) => canon.has(k))).toBe(true);
  });
  test('FP: superset input does not match a shorter single-token canonical', () => {
    // "Hazy Mango" (2-token key) vs "Hazy" (1-token, dropped) → no shared key
    expect(intersects(nameKeys('Hazy Mango', 'Foo'), nameKeys('Hazy', 'Foo'))).toBe(false);
  });
  test('regression: Fifty/Fifty Clementine keys only the 2-token side, not "fifty"', () => {
    const input = nameKeys('Fifty/Fifty Clementine & Passionfruit', 'Magic Road');
    expect(intersects(input, nameKeys('Fifty / Fifty Clementine & Passionfruit', 'Magic Road'))).toBe(true);
    expect(intersects(input, nameKeys('Fifty / Fifty - Pineapple', 'Magic Road'))).toBe(false);
  });
});

describe('matchPrepared key-intersection (#117)', () => {
  const cat: CatalogBeer[] = [
    c({ id: 10, brewery: 'Schneider Weisse', name: 'Festweisse (TAP04)' }),
    c({ id: 11, brewery: 'Root + Branch', name: 'Fast Talking' }),
  ];
  test('reordered name matches as exact (source=exact, confidence 1)', () => {
    const m = matchBeer({ brewery: 'Schneider', name: 'TAP04 FESTWEISSE' }, cat);
    expect(m).toEqual({ id: 10, confidence: 1, source: 'exact' });
  });
  test('collab partner in input name matches the base beer as exact', () => {
    const m = matchBeer({ brewery: 'Root + Branch', name: 'Fast Talking / North Park' }, cat);
    expect(m).toEqual({ id: 11, confidence: 1, source: 'exact' });
  });
});

describe('candidatesByFirstToken', () => {
  const cat: CatalogBeer[] = [
    c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu' }),
    c({ id: 2, brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter' }),
  ];
  test('returns rows whose brewery-alias first token equals the key', () => {
    const ids = prepareCatalog(cat).candidatesByFirstToken('pastry').map((b) => b.id);
    expect(ids).toEqual([2]);
  });
  test('unknown token returns empty array', () => {
    expect(prepareCatalog(cat).candidatesByFirstToken('zzz')).toEqual([]);
  });
});

describe('split-invariant anchored second try (#169)', () => {
  const cat: CatalogBeer[] = [
    c({ id: 12544, brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter', abv: 8.0 }),
    c({ id: 300, brewery: 'Mad Brew', name: 'Galaxy Juice', abv: 6.0 }),
    c({ id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1 }),
  ];

  test('all three brewery/name splits resolve to the same exact id', () => {
    const inputs = [
      { brewery: '', name: 'Pastry Mastery Schwarzbrot Porter' },
      { brewery: 'Pastry', name: 'Mastery Schwarzbrot Porter' },
      { brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter' },
    ];
    for (const input of inputs) {
      expect(matchBeer(input, cat)).toEqual({ id: 12544, confidence: 1, source: 'exact' });
    }
  });

  test('two-word brewery split mid-title (Mad Brew) → exact', () => {
    expect(matchBeer({ brewery: 'Mad', name: 'Brew Galaxy Juice' }, cat))
      .toEqual({ id: 300, confidence: 1, source: 'exact' });
  });

  test('brewery genuinely absent does NOT anchor onto Pastry Mastery', () => {
    // No brewery tokens in the title → the leading-token bucket has no candidate.
    expect(matchBeer({ brewery: '', name: 'Schwarzbrot Porter' }, cat)?.source)
      .not.toBe('exact');
  });

  test('same brewery, different name remainder → no false exact', () => {
    expect(matchBeer({ brewery: 'Pastry', name: 'Mastery Hazelnut Stout' }, cat)?.source)
      .not.toBe('exact');
  });

  test('anchored hit still respects ABV disambiguation across vintages', () => {
    const vintages: CatalogBeer[] = [
      c({ id: 200, brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter', abv: 8.0 }),
      c({ id: 201, brewery: 'Pastry Mastery', name: 'Schwarzbrot Porter', abv: 5.0 }),
    ];
    // Mis-split input with abv 5.0 must pick the matching-abv row, not just newest id.
    expect(matchBeer({ brewery: 'Pastry', name: 'Mastery Schwarzbrot Porter', abv: 5.0 }, vintages))
      .toEqual({ id: 201, confidence: 1, source: 'exact' });
  });

  test('anchors via a collab-brewery alias when the second partner leaks into the name', () => {
    // Catalog brewery is a collab "Pinta / Mad Crow"; the adapter kept only "Pinta" as the
    // brewery and leaked "Mad Crow" into the name. The full-collab alias "pinta mad crow"
    // is a leading run of the combined title, so the anchored try must still hit exact.
    const collab: CatalogBeer[] = [
      c({ id: 700, brewery: 'Pinta / Mad Crow', name: 'Schwarzbrot', abv: 6.0 }),
    ];
    expect(matchBeer({ brewery: 'Pinta', name: 'Mad Crow Schwarzbrot' }, collab))
      .toEqual({ id: 700, confidence: 1, source: 'exact' });
  });
});

describe('stripBreweryFromName', () => {
  test('strips a leading run', () => {
    expect(stripBreweryFromName('primator weizen', 'primator')).toBe('weizen');
  });
  test('strips a trailing run (#155 Trzech Kumpli)', () => {
    expect(stripBreweryFromName('baltycki zytnio orkiszowy trzech kumpli', 'trzech kumpli')).toBe(
      'baltycki zytnio orkiszowy',
    );
  });
  test('strips a mid run', () => {
    expect(stripBreweryFromName('cydr chyliczki stary sad', 'chyliczki')).toBe('cydr stary sad');
  });
  test('trims a stranded trailing brewery-noise token after the run', () => {
    expect(stripBreweryFromName('kosmaty trzech kumpli brewery', 'trzech kumpli')).toBe('kosmaty');
  });
  test('removes multiple non-adjacent runs', () => {
    expect(stripBreweryFromName('trzech kumpli kosmaty trzech kumpli', 'trzech kumpli')).toBe(
      'kosmaty',
    );
  });
  test('never strips the name to empty (name == brewery)', () => {
    expect(stripBreweryFromName('trzech kumpli', 'trzech kumpli')).toBe('trzech kumpli');
  });
  test('keeps one run when the name is nothing but repeated brewery (≥1-token guard)', () => {
    expect(stripBreweryFromName('trzech kumpli trzech kumpli', 'trzech kumpli')).toBe('trzech kumpli');
  });
  test('passthrough when brewery is empty (keeps #138B brand path intact)', () => {
    expect(stripBreweryFromName('murphy s irish stout', '')).toBe('murphy s irish stout');
  });
});
