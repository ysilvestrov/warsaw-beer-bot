import { vi } from 'vitest';
import { matchBeerList, buildAliasIndex, type CatalogBeerWithRating } from './match-list';
import { cardAbv, cardText } from './card-text';
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
        source: 'exact',
        searched: true,
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
      source: null,
      searched: true,
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

  it('reports how the catalog row was reached', async () => {
    const { prepared, byId } = prep(catalog);
    const exact = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(exact.results[0].source).toBe('exact');

    // "Atak Chmiel" (typo) reaches catalog 200 only through the fuzzy stage.
    const fuzzy = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmiel' },
    ]);
    expect(fuzzy.results[0].matched_beer?.id).toBe(200);
    expect(fuzzy.results[0].source).toBe('fuzzy');

    const miss = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'Trzech Kumpli', name: 'Nothing Like This' },
    ]);
    expect(miss.results[0].matched_beer).toBeNull();
    expect(miss.results[0].source).toBeNull();
  });

  it('separates "searched and missed" from "never searched" (fallback budget)', async () => {
    // One-beer catalog; every input has an unknown brewery, so all of them fall to the
    // budgeted full-catalog path. The surplus past the budget is never searched at all.
    const { prepared, byId } = prep([
      { id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
    ]);
    const n = FULL_FALLBACK_BUDGET + 3;
    const items = Array.from({ length: n }, (_, i) => ({ brewery: `Unknown${i}`, name: `Mystery ${i}` }));
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), items);

    expect(res.results.slice(0, FULL_FALLBACK_BUDGET).every((r) => r.searched)).toBe(true);
    expect(res.results.slice(FULL_FALLBACK_BUDGET).map((r) => r.searched)).toEqual([false, false, false]);
    // Both halves look identical on matched_beer — that is exactly the ambiguity being removed.
    expect(res.results.every((r) => r.matched_beer === null)).toBe(true);
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

describe('matchBeerList aliases (#614)', () => {
  const rochefort: CatalogBeerWithRating[] = [
    { id: 8, brewery: 'Brasserie de Rochefort', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.95, untappd_id: 1001 },
    { id: 10, brewery: 'Brasserie de Rochefort', name: 'Trappistes Rochefort 10', abv: 11.3, rating_global: 4.2, untappd_id: 2002 },
  ];
  const alias = (beerId: number, brewery: string, name: string, abv?: number | null) => ({
    beer_id: beerId, brewery_text: cardText(brewery), name_text: cardText(name), abv_key: cardAbv(abv),
  });
  const noYield = { yield: async () => {} };
  const run = async (catalog: CatalogBeerWithRating[], aliasRows: ReturnType<typeof alias>[], card: { brewery: string; name: string; abv?: number }, drunkId: number) => {
    const { prepared, byId } = prep(catalog);
    const aliases = await buildAliasIndex(aliasRows, catalog);
    return matchBeerList(prepared, byId, new Set([drunkId]), new Map([[drunkId, 4.0]]), [card], { ...noYield, aliases });
  };

  it('a merged card text matches its canonical row exactly, with drunk status and rating, without the fallback', async () => {
    const res = await run(rochefort, [alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)], { brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2 }, 8);
    expect(res.results).toEqual([{
      raw: { brewery: 'ROCH', name: 'Trappistes Rochefort 8' },
      matched_beer: { id: 8, name: 'Trappistes Rochefort 8', brewery: 'Brasserie de Rochefort', rating_global: 3.95, untappd_id: 1001 },
      is_drunk: true, drunk_uncertain: false, user_rating: 4.0, source: 'exact', searched: true,
    }]);
    expect(res.fallback.attempts).toBe(0);
  });

  it('case and whitespace of the same text still hit the alias', async () => {
    const [r] = (await run(rochefort, [alias(8, 'ROCH', 'Trappistes Rochefort 8')], { brewery: ' roch ', name: 'trappistes  ROCHEFORT 8' }, 8)).results;
    expect([r.source, r.matched_beer?.id, r.is_drunk]).toEqual(['exact', 8, true]);
  });

  // Сценарії трьох рев'ю: жоден інший зміст не дістає аліасу.
  it.each([
    ['other digits', { brewery: 'ROCH', name: 'Trappistes Rochefort 10', abv: 11.3 }, alias(8, 'ROCH', 'Trappistes Rochefort 8')],
    ['a year only on the card', { brewery: 'ROCH', name: 'Trappistes Rochefort 8 2023' }, alias(8, 'ROCH', 'Trappistes Rochefort 8')],
    ['another year inside parentheses', { brewery: 'ROCH', name: 'Rochefort (2024 Extra Vanilla)' }, alias(8, 'ROCH', 'Rochefort (2023 Banana Pudding)')],
  ])('%s never rides the alias', async (_label, card, aliasRow) => {
    const [r] = (await run(rochefort, [aliasRow], card, 8)).results;
    expect(r.is_drunk).toBe(false);
    expect(r.source === 'exact' && r.matched_beer?.id === 8).toBe(false);
  });

  it('a card with an empty brewery text never looks up an alias', async () => {
    const [r] = (await run(rochefort, [alias(8, '', 'Trappistes Rochefort 8')], { brewery: '  ', name: 'Trappistes Rochefort 8' }, 8)).results;
    expect(r.source === 'exact' && r.matched_beer?.id === 8 && r.is_drunk).toBe(false);
  });

  it('a card with an empty name text never looks up an alias', async () => {
    const [r] = (await run(rochefort, [alias(8, 'ROCH', '')], { brewery: 'ROCH', name: '  ' }, 8)).results;
    expect(r.source === 'exact' && r.matched_beer?.id === 8 && r.is_drunk).toBe(false);
  });

  it('buildAliasIndex drops an alias whose exact text another catalog row holds — the row wins', async () => {
    const catalog = [...rochefort, { id: 77, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: null, untappd_id: null }];
    expect((await buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort 8')], catalog)).size).toBe(0);
    // Той самий текст лише в самій цілі — аліас лишається.
    const selfHeld = [{ id: 8, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.95, untappd_id: 1001 }];
    expect([...(await buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort 8')], selfHeld)).values()]).toEqual([8]);
  });

  it('an ABV twin never rides the alias of the other ABV', async () => {
    const leffe: CatalogBeerWithRating[] = [
      { id: 5940, brewery: 'Abbaye de Leffe', name: 'Leffe Blonde / Blond', abv: 6.6, rating_global: 3.5, untappd_id: 5940 },
      { id: 3658, brewery: 'Abbaye de Leffe', name: 'Leffe Blonde / Blond 0,0%', abv: 0, rating_global: 3.2, untappd_id: 2948556 },
    ];
    const [r] = (await run(leffe, [alias(3658, 'LEFFE', 'BLONDE', 0)], { brewery: 'LEFFE', name: 'BLONDE', abv: 6.6 }, 3658)).results;
    expect(r.is_drunk).toBe(false);
    expect(r.source === 'exact' && r.matched_beer?.id === 3658).toBe(false);
  });

  it('a card without an ABV never rides an alias recorded with one', async () => {
    const [r] = (await run(rochefort, [alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)], { brewery: 'ROCH', name: 'Trappistes Rochefort 8' }, 8)).results;
    expect(r.source === 'exact' && r.matched_beer?.id === 8 && r.is_drunk).toBe(false);
  });

  it('buildAliasIndex yields to the event loop once per 2000 catalog rows', async () => {
    const big = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, brewery: `Brew ${i}`, name: `Beer ${i}` }));
    const yieldSpy = vi.fn(() => Promise.resolve());
    await buildAliasIndex([], big, yieldSpy);
    expect(yieldSpy.mock.calls.length).toBe(2);
  });
});
