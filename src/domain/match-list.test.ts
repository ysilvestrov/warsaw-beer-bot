import { matchBeerList, type CatalogBeerWithRating } from './match-list';
import { matchBeer } from './matcher';

const catalog: CatalogBeerWithRating[] = [
  { id: 105, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85 },
  { id: 200, brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
];

describe('matchBeerList', () => {
  it('marks a matched, drunk beer with its personal rating', async () => {
    const res = await matchBeerList(
      catalog,
      new Set([105]),
      new Map([[105, 4.0]]),
      [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }],
    );
    expect(res).toEqual([
      {
        raw: { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
        matched_beer: { id: 105, name: 'Pan IPAni', brewery: 'Trzech Kumpli', rating_global: 3.85, untappd_id: null },
        is_drunk: true,
        user_rating: 4.0,
      },
    ]);
  });

  it('passes untappd_id through to matched_beer', async () => {
    const cat: CatalogBeerWithRating[] = [
      { id: 300, brewery: 'PINTA', name: 'Viva la Wit', abv: 4.8, rating_global: 3.6, untappd_id: 555 },
    ];
    const res = await matchBeerList(cat, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Viva la Wit' },
    ]);
    expect(res[0].matched_beer).toEqual({
      id: 300, name: 'Viva la Wit', brewery: 'PINTA', rating_global: 3.6, untappd_id: 555,
    });
  });

  it('drunk via had-list only → is_drunk true, user_rating null', async () => {
    const res = await matchBeerList(catalog, new Set([200]), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
    ]);
    expect(res[0].is_drunk).toBe(true);
    expect(res[0].user_rating).toBeNull();
  });

  it('no catalog match → matched_beer null, not drunk', async () => {
    const res = await matchBeerList(catalog, new Set(), new Map(), [
      { brewery: 'Nowhere', name: 'Unknown Stout' },
    ]);
    expect(res[0]).toEqual({
      raw: { brewery: 'Nowhere', name: 'Unknown Stout' },
      matched_beer: null,
      is_drunk: false,
      user_rating: null,
    });
  });

  it('preserves input order', async () => {
    const res = await matchBeerList(catalog, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(res.map((r) => r.matched_beer?.id)).toEqual([200, 105]);
  });
});

describe('matchBeerList — prepare-once equivalence', () => {
  const bigCatalog: CatalogBeerWithRating[] = [
    { id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
    { id: 2, brewery: 'Stu Mostów', name: 'Buty Skejta', abv: 5.0, rating_global: 3.5 },
    { id: 3, brewery: 'Piwne Podziemie', name: 'Hopinka', abv: 6.0, rating_global: 3.6 },
    { id: 4, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85 },
    { id: 5, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.5, rating_global: 3.7 },
  ];

  const inputs = [
    { brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1 },   // exact + abv
    { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },          // exact, no abv
    { brewery: 'Piwne Podziemie Brewery', name: 'Hopinka' },  // noise-word brewery
    { brewery: 'Stu Mostow', name: 'Buty Skejt' },            // fuzzy
    { brewery: 'Nowhere', name: 'Totally Unknown Stout' },    // no match
  ];

  it('per-batch result equals matching each beer alone', async () => {
    const batch = await matchBeerList(bigCatalog, new Set(), new Map(), inputs);
    inputs.forEach((input, i) => {
      const solo = matchBeer(input, bigCatalog);
      expect(batch[i].matched_beer?.id ?? null).toBe(solo?.id ?? null);
    });
  });
});

describe('matchBeerList — cooperative yielding', () => {
  it('yields between prep chunks and after each beer', async () => {
    // 2001 rows → ceil(2001/2000) = 2 prep-chunk yields.
    const big: CatalogBeerWithRating[] = Array.from({ length: 2001 }, (_, i) => ({
      id: i + 1, brewery: `Brew ${i}`, name: `Beer ${i}`, abv: null, rating_global: null,
    }));
    const items = [
      { brewery: 'Brew 0', name: 'Beer 0' },   // exact match
      { brewery: 'Nowhere', name: 'Unknown' }, // empty-pool fallback
    ];
    const yieldSpy = jest.fn(() => Promise.resolve());
    await matchBeerList(big, new Set(), new Map(), items, { yield: yieldSpy });
    // 2 prep-chunk yields + 1 yield per beer.
    expect(yieldSpy.mock.calls.length).toBe(2 + items.length);
  });
});
