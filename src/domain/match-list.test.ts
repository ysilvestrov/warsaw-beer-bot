import { vi } from 'vitest';
import { matchBeerList, type CatalogBeerWithRating } from './match-list';
import { matchBeer, prepareCatalog, FULL_FALLBACK_BUDGET } from './matcher';

// The route now hands matchBeerList an already-prepared catalog + id index; tests
// build them the same way the cache does.
function prep(catalog: CatalogBeerWithRating[]) {
  return { prepared: prepareCatalog(catalog), byId: new Map(catalog.map((c) => [c.id, c])) };
}

const catalog: CatalogBeerWithRating[] = [
  { id: 105, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85 },
  { id: 200, brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
];

describe('matchBeerList', () => {
  it('marks a matched, drunk beer with its personal rating', async () => {
    const { prepared, byId } = prep(catalog);
    const res = await matchBeerList(
      prepared,
      byId,
      new Set([105]),
      new Map([[105, 4.0]]),
      [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }],
    );
    expect(res.results).toEqual([
      {
        raw: { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
        matched_beer: { id: 105, name: 'Pan IPAni', brewery: 'Trzech Kumpli', rating_global: 3.85, untappd_id: null },
        is_drunk: true,
        drunk_uncertain: false,
        user_rating: 4.0,
      },
    ]);
  });

  it('a fuzzy match never claims drunk or personal rating', async () => {
    // "Atak Chmiel" (typo) fuzzy-matches catalog 200 "Atak Chmielu". Even though 200 is
    // in the drunk set with a rating, a fuzzy match must not assert drunk/personal.
    const { prepared, byId } = prep(catalog);
    const res = await matchBeerList(
      prepared,
      byId,
      new Set([200]),
      new Map([[200, 4.5]]),
      [{ brewery: 'PINTA', name: 'Atak Chmiel' }],
    );
    expect(res.results[0].matched_beer?.id).toBe(200);
    expect(res.results[0].is_drunk).toBe(false);
    expect(res.results[0].user_rating).toBeNull();
    expect(res.results[0].drunk_uncertain).toBe(true);
  });

  it('drunk_uncertain is false for exact, non-drunk-fuzzy, and no-match', async () => {
    const { prepared, byId } = prep(catalog);
    const exactDrunk = await matchBeerList(prepared, byId, new Set([200]), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
    ]);
    expect(exactDrunk.results[0].is_drunk).toBe(true);
    expect(exactDrunk.results[0].drunk_uncertain).toBe(false);

    const fuzzyNotDrunk = await matchBeerList(prepared, byId, new Set<number>(), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmiel' },
    ]);
    expect(fuzzyNotDrunk.results[0].is_drunk).toBe(false);
    expect(fuzzyNotDrunk.results[0].drunk_uncertain).toBe(false);

    const noMatch = await matchBeerList(prepared, byId, new Set([200]), new Map(), [
      { brewery: 'Nope', name: 'Does Not Exist At All' },
    ]);
    expect(noMatch.results[0].matched_beer).toBe(null);
    expect(noMatch.results[0].drunk_uncertain).toBe(false);
  });

  it('passes untappd_id through to matched_beer', async () => {
    const cat: CatalogBeerWithRating[] = [
      { id: 300, brewery: 'PINTA', name: 'Viva la Wit', abv: 4.8, rating_global: 3.6, untappd_id: 555 },
    ];
    const { prepared, byId } = prep(cat);
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Viva la Wit' },
    ]);
    expect(res.results[0].matched_beer).toEqual({
      id: 300, name: 'Viva la Wit', brewery: 'PINTA', rating_global: 3.6, untappd_id: 555,
    });
  });

  it('drunk via had-list only → is_drunk true, user_rating null', async () => {
    const { prepared, byId } = prep(catalog);
    const res = await matchBeerList(prepared, byId, new Set([200]), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
    ]);
    expect(res.results[0].is_drunk).toBe(true);
    expect(res.results[0].user_rating).toBeNull();
  });

  it('no catalog match → matched_beer null, not drunk', async () => {
    const { prepared, byId } = prep(catalog);
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'Nowhere', name: 'Unknown Stout' },
    ]);
    expect(res.results[0]).toEqual({
      raw: { brewery: 'Nowhere', name: 'Unknown Stout' },
      matched_beer: null,
      is_drunk: false,
      drunk_uncertain: false,
      user_rating: null,
    });
  });

  it('preserves input order', async () => {
    const { prepared, byId } = prep(catalog);
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(res.results.map((r) => r.matched_beer?.id)).toEqual([200, 105]);
  });

  it('shares one full-fallback budget across the batch and returns it', async () => {
    // A catalog of one beer; N+1 unknown-brewery inputs all fall to the full-catalog
    // path. With a batch larger than the budget, the surplus is skipped.
    const { prepared, byId } = prep([
      { id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
    ]);
    const n = FULL_FALLBACK_BUDGET + 3;
    const items = Array.from({ length: n }, (_, i) => ({ brewery: `Unknown${i}`, name: `Mystery ${i}` }));
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), items);
    expect(res.results).toHaveLength(n);
    expect(res.fallback.attempts).toBe(n);
    expect(res.fallback.budgetSkipped).toBe(3);
    expect(res.fallback.remaining).toBe(0);
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
    const { prepared, byId } = prep(bigCatalog);
    const batch = await matchBeerList(prepared, byId, new Set(), new Map(), inputs);
    inputs.forEach((input, i) => {
      const solo = matchBeer(input, bigCatalog);
      expect(batch.results[i].matched_beer?.id ?? null).toBe(solo?.id ?? null);
    });
  });
});

describe('matchBeerList — cooperative yielding', () => {
  it('yields once after each beer', async () => {
    const { prepared, byId } = prep([
      { id: 1, brewery: 'Brew 0', name: 'Beer 0', abv: null, rating_global: null },
    ]);
    const items = [
      { brewery: 'Brew 0', name: 'Beer 0' },   // exact match
      { brewery: 'Nowhere', name: 'Unknown' }, // no match
    ];
    const yieldSpy = vi.fn(() => Promise.resolve());
    await matchBeerList(prepared, byId, new Set(), new Map(), items, { yield: yieldSpy });
    expect(yieldSpy.mock.calls.length).toBe(items.length);
  });
});
