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
    const aliases = buildAliasIndex(aliasRows);
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

  it('#614 a `|` inside the card text never makes two cards share one alias key', async () => {
    // AI-рев'ю PR #644: склейка полів через `|` зводила ('a|b', 'c') і ('a', 'b|c') в один ключ мапи — пізніший аліас
    // перебивав ранній, і картка отримувала чужий рядок. Обидва аліаси в індексі, кожна картка — свій.
    const aliasRows = [alias(8, 'ROCH|BREW', 'Rochefort', 9.2), alias(10, 'ROCH', 'BREW|Rochefort', 9.2)];
    const [r8] = (await run(rochefort, aliasRows, { brewery: 'ROCH|BREW', name: 'Rochefort', abv: 9.2 }, 8)).results;
    expect([r8.source, r8.matched_beer?.id, r8.is_drunk]).toEqual(['exact', 8, true]);
    const [r10] = (await run(rochefort, aliasRows, { brewery: 'ROCH', name: 'BREW|Rochefort', abv: 9.2 }, 10)).results;
    expect([r10.source, r10.matched_beer?.id, r10.is_drunk]).toEqual(['exact', 10, true]);
  });

  it('a card with an empty name text never looks up an alias', async () => {
    const [r] = (await run(rochefort, [alias(8, 'ROCH', '')], { brewery: 'ROCH', name: '  ' }, 8)).results;
    expect(r.source === 'exact' && r.matched_beer?.id === 8 && r.is_drunk).toBe(false);
  });

  it('#614 the alias answers its exact key even when a linked catalog row holds the same text and ABV', async () => {
    // Рев'ю 10: конфлікт доказів для тієї самої картки розв'язує запис (новіший доказ переносить аліас), не читання.
    const withSameKey = [...rochefort, { id: 77, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.1, untappd_id: 7777 }];
    const [r] = (await run(withSameKey, [alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)], { brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2 }, 8)).results;
    expect([r.source, r.matched_beer?.id, r.is_drunk]).toEqual(['exact', 8, true]);
  });

  it('#614 a linked ABV twin with the same text does not switch the other ABV alias off', async () => {
    // Рев'ю 9, M1: вимкнений аліас віддавав картці рядок близнюка як exact, і репарація #384 ганяла пінг-понг злиттів.
    const withTwin = [...rochefort, { id: 77, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 7.5, rating_global: 3.1, untappd_id: 7777 }];
    const [r] = (await run(withTwin, [alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)], { brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2 }, 8)).results;
    expect([r.source, r.matched_beer?.id, r.is_drunk]).toEqual(['exact', 8, true]);
  });

  it('#614 an orphan with the same exact text does not switch the alias off', async () => {
    // Сирота з текстом картки — наш плейсхолдер (/enrich/candidates для ABV-близнюка), а не доказ: без аліасу
    // /match віддав би на неї exact без untappd_id і без статусу «пив» (проба periph-abvtwin).
    const withOrphan = [...rochefort, { id: 77, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: null, untappd_id: null }];
    const [r] = (await run(withOrphan, [alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)], { brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2 }, 8)).results;
    expect([r.source, r.matched_beer?.id, r.is_drunk]).toEqual(['exact', 8, true]);
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
});

const bidCatalog: CatalogBeerWithRating[] = [
  { id: 300, brewery: 'pHormula', name: 'Bosbes', abv: 6.0, rating_global: 4.1, untappd_id: 4333527 },
  { id: 301, brewery: 'Mad Brew', name: 'Bosbes', abv: 6.0, rating_global: 3.2, untappd_id: 999001 },
  { id: 302, brewery: 'Mad Brew', name: 'Harissa', abv: 5.0, rating_global: 3.9, untappd_id: 999002 },
];

function prepBid() {
  const byId = new Map(bidCatalog.map((c) => [c.id, c]));
  const byUntappdId = new Map(bidCatalog.filter((c) => c.untappd_id != null).map((c) => [c.untappd_id!, c]));
  return { prepared: prepareCatalog(bidCatalog), byId, byUntappdId };
}

describe('matchBeerList — published bid (#633)', () => {
  it('a bid whose brewery agrees wins over an exact name match on another row', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set([300]), new Map([[300, 4.5]]),
      [{ brewery: 'Mad Brew', name: 'Bosbes', bid: 4333527, brand: 'pHormula' }],
      { byUntappdId },
    );
    // name alone would give 301 (Mad Brew / Bosbes); the bid names 300 and its brand agrees.
    expect(res.results[0].matched_beer?.id).toBe(300);
    expect(res.results[0].source).toBe('exact');
    expect(res.results[0].is_drunk).toBe(true);
    expect(res.results[0].user_rating).toBe(4.5);
    expect(res.bid).toEqual({ sent: 1, exact: 1, conflict: 0, aliasKept: 0 });
  });

  it('a placeholder brand falls back to the card brewery as evidence', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'pHormula', name: 'Something Else', bid: 4333527, brand: 'Імпортне пиво' }],
      { byUntappdId },
    );
    expect(res.results[0].matched_beer?.id).toBe(300);
    expect(res.results[0].source).toBe('exact');
  });

  it('a conflicting brewery still gives exact when the name landed on the bid row', async () => {
    // The name must reach the bid row through FUZZY ("Bosbe" is a typo), otherwise the name
    // route already returns exact and the upgrade under test would be a no-op — a vacuous
    // test that survives deleting the rule (caught by mutation, 2026-09-15).
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set([301]), new Map([[301, 3.0]]),
      [{ brewery: 'Mad Brew', name: 'Bosbe', bid: 999001, brand: 'VibrantPour' }],
      { byUntappdId },
    );
    // brand VibrantPour disagrees with Mad Brew, but the name route reached row 301 itself,
    // so two independent witnesses agree and the answer is exact — with the drunk status a
    // fuzzy match would never assert.
    expect(res.results[0].matched_beer?.id).toBe(301);
    expect(res.results[0].source).toBe('exact');
    expect(res.results[0].is_drunk).toBe(true);
    expect(res.results[0].user_rating).toBe(3.0);
    expect(res.results[0].drunk_uncertain).toBe(false);
    expect(res.bid).toEqual({ sent: 1, exact: 1, conflict: 0, aliasKept: 0 });
  });

  it('a conflicting brewery with a different name match reads as fuzzy on the bid row', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set([302]), new Map([[302, 4.2]]),
      [{ brewery: 'Mad Brew', name: 'Bosbes', bid: 999002, brand: 'Pastry Mastery' }],
      { byUntappdId },
    );
    expect(res.results[0].matched_beer?.id).toBe(302);
    expect(res.results[0].source).toBe('fuzzy');
    expect(res.results[0].is_drunk).toBe(false);
    expect(res.results[0].user_rating).toBeNull();
    expect(res.results[0].drunk_uncertain).toBe(true); // 302 is in the drunk set
    expect(res.bid).toEqual({ sent: 1, exact: 0, conflict: 1, aliasKept: 0 });
  });

  it('a bid outside the snapshot changes nothing', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const withBid = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'Mad Brew', name: 'Bosbes', bid: 123456, brand: 'Mad Brew' }],
      { byUntappdId },
    );
    const without = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'Mad Brew', name: 'Bosbes' }],
      { byUntappdId },
    );
    expect(withBid.results).toEqual(without.results);
    expect(withBid.bid).toEqual({ sent: 1, exact: 0, conflict: 0, aliasKept: 0 });
  });

  it('an agreeing bid beats the #614 alias for the same card', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const aliases = buildAliasIndex([
      { beer_id: 302, brewery_text: cardText('Mad Brew'), name_text: cardText('Bosbes'), abv_key: cardAbv(6) },
    ]);
    const res = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'Mad Brew', name: 'Bosbes', abv: 6, bid: 999001, brand: 'Mad Brew' }],
      { byUntappdId, aliases },
    );
    expect(res.results[0].matched_beer?.id).toBe(301); // the bid row, not the alias target 302
    expect(res.results[0].source).toBe('exact');
  });

  it('an agreeing bid spends no full-catalog fallback budget', async () => {
    // The card text matches NOTHING in this catalog, so without the bid rule every item
    // would spend a full-catalog fallback attempt — that is what keeps this test honest.
    const { prepared, byId, byUntappdId } = prepBid();
    const items = Array.from({ length: FULL_FALLBACK_BUDGET + 5 }, () => ({
      brewery: 'Zzz Unknown Brewing', name: 'Qqq Nothing Like It', bid: 4333527, brand: 'pHormula',
    }));
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), items, { byUntappdId });
    expect(res.fallback.attempts).toBe(0);
    expect(res.fallback.budgetSkipped).toBe(0);
    expect(res.results.every((r) => r.matched_beer?.id === 300)).toBe(true);
  });

  it('#614 an alias keeps the card when the bid contradicts the brewery', async () => {
    // The merge memory is OUR proven identity for this exact card; the contradicting bid is
    // the evidence class the design itself calls weak, so it must not take the card away.
    // The contradiction still reaches the repair path: /match returns a row whose untappd_id
    // differs from the published bid, which is exactly what the client sends to /enrich (#384).
    const { prepared, byId, byUntappdId } = prepBid();
    const aliases = buildAliasIndex([
      { beer_id: 302, brewery_text: cardText('Mad Brew'), name_text: cardText('Bosbes'), abv_key: cardAbv(6) },
    ]);
    const res = await matchBeerList(
      prepared, byId, new Set([302]), new Map([[302, 4.5]]),
      [{ brewery: 'Mad Brew', name: 'Bosbes', abv: 6, bid: 4333527, brand: 'Teréna' }],
      { byUntappdId, aliases },
    );
    expect(res.results[0].matched_beer?.id).toBe(302);
    expect(res.results[0].source).toBe('exact');
    expect(res.results[0].is_drunk).toBe(true);
    expect(res.results[0].user_rating).toBe(4.5);
    expect(res.bid).toEqual({ sent: 1, exact: 0, conflict: 0, aliasKept: 1 });
  });

  it('a conflicting bid reports the fallback budget truthfully in `searched`', async () => {
    // `searched: false` means the budgeted full-catalog fallback did not run for this item
    // (spec.md §POST /match). Hardcoding `true` on the bid path would claim a search we denied.
    const { prepared, byId, byUntappdId } = prepBid();
    const filler = Array.from({ length: FULL_FALLBACK_BUDGET }, (_, i) => ({
      brewery: `Nobody ${i}`, name: `Nothing At All ${i}`,
    }));
    const denied = { brewery: 'Nobody Left', name: 'Nothing At All Left', bid: 999002, brand: 'Pastry Mastery' };
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), [...filler, denied], { byUntappdId });
    const last = res.results[res.results.length - 1];
    expect(res.fallback.budgetSkipped).toBeGreaterThan(0);
    expect(last.matched_beer?.id).toBe(302); // answered by the bid
    expect(last.source).toBe('fuzzy');
    expect(last.searched).toBe(false);
  });

  it('a bid with no brand at all is ignored — the card brewery alone is not evidence', async () => {
    // Without a brand the only witness would be the card's own brewery, which the Flasker
    // adapter derives from the title and gets wrong for 57 of 709 cards (#650).
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'pHormula', name: 'Something Else', bid: 4333527 }],
      { byUntappdId },
    );
    expect(res.results[0].matched_beer).toBeNull();
    expect(res.bid).toEqual({ sent: 1, exact: 0, conflict: 0, aliasKept: 0 });
  });
});
