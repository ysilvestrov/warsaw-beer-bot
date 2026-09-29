import { lookupBeer } from './untappd-lookup';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

function fakeSearch(results: SearchResult[]): BeerSearch {
  return { search: async () => results };
}
const r = (bid: number, brewery_name: string, beer_name: string, abv: number | null, rating_count = 100): SearchResult =>
  ({ bid, brewery_name, beer_name, abv, style: null, global_rating: 3.5, rating_count });

const ARTEZAN = [
  r(6843957, 'Browar Artezan', 'UHT', 6.5, 52),
  r(5474194, 'Browar Artezan', 'And the Planets Are Going Crazy', 6.3, 283),
  r(5462826, 'Browar Artezan', 'Lost in the Woods', 5.5, 186),
];
const MOON_LARK = [
  r(5322744, 'Moon Lark Brewery', 'Silk.', 5, 1715),
  r(6307352, 'Moon Lark Brewery', 'Slice.', 6, 822),
];

describe('#659 moved-letter rescue', () => {
  // Live rows 2026-09-29, candidates as the replay returned them.
  test('37582 UTH → UHT (no approximate stage sees it: the null refusal point)', async () => {
    const out = await lookupBeer({ brewery: 'Artezan Brewery', name: 'UTH 15°', abv: 6.5, search: fakeSearch(ARTEZAN) });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 6843957 } });
  });

  test('37911 Slik → Silk. beside Slice. (near-name tie: the not_found refusal point)', async () => {
    const out = await lookupBeer({ brewery: 'MOON LARK Brewery', name: 'Moon Lark Slik 12.0°', abv: 5, search: fakeSearch(MOON_LARK) });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 5322744 } });
  });

  test('38383 Tounge Tingle → Tongue Tingle (letter moved two places)', async () => {
    const out = await lookupBeer({
      brewery: 'Monsters Brewery', name: 'Tounge Tingle', abv: 6,
      search: fakeSearch([r(6849257, 'Browar Monsters', 'Tongue Tingle', 6, 101)]),
    });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 6849257 } });
  });

  test('ABV outside tolerance → not_found', async () => {
    const out = await lookupBeer({ brewery: 'Artezan Brewery', name: 'UTH 15°', abv: 7.0, search: fakeSearch(ARTEZAN) });
    expect(out.kind).toBe('not_found');
  });

  test('input ABV unknown → not_found', async () => {
    const out = await lookupBeer({ brewery: 'Artezan Brewery', name: 'UTH 15°', search: fakeSearch(ARTEZAN) });
    expect(out.kind).toBe('not_found');
  });

  test('candidate ABV unknown → not_found', async () => {
    const out = await lookupBeer({
      brewery: 'Artezan Brewery', name: 'UTH 15°', abv: 6.5,
      search: fakeSearch([r(6843957, 'Browar Artezan', 'UHT', null, 52)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('two qualifying bids (Silk and Lisk, both 5%) → not_found', async () => {
    const out = await lookupBeer({
      brewery: 'MOON LARK Brewery', name: 'Moon Lark Slik 12.0°', abv: 5,
      search: fakeSearch([r(5322744, 'Moon Lark Brewery', 'Silk.', 5, 1715), r(1, 'Moon Lark Brewery', 'Lisk', 5, 1715)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('restored candidate identity (bare style word IPA) → not_found', async () => {
    const out = await lookupBeer({
      brewery: 'Browar Testowy', name: 'IAP', abv: 5,
      search: fakeSearch([r(2, 'Browar Testowy', 'IPA', 5)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('relaxed brewery pool (empty input brewery) never rescues', async () => {
    const out = await lookupBeer({ brewery: '', name: 'UTH', abv: 6.5, search: fakeSearch(ARTEZAN) });
    expect(out.kind).toBe('not_found');
  });

  test('a match an existing stage accepts is unchanged by a moved-letter neighbour', async () => {
    const out = await lookupBeer({
      brewery: 'Monsters Brewery', name: 'Tounge Tingle', abv: 6,
      search: fakeSearch([
        r(3, 'Browar Monsters', 'Tounge Tingle Reserve', 6, 50),
        r(6849257, 'Browar Monsters', 'Tongue Tingle', 6, 101),
      ]),
    });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 3 } });
  });

  test('restored input identity (bare style word IPA) → not_found', async () => {
    const out = await lookupBeer({
      brewery: 'Browar Testowy', name: 'IPA', abv: 5,
      search: fakeSearch([r(2, 'Browar Testowy', 'IAP', 5)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('single-token collab side (exactOnly) never rescues', async () => {
    const out = await lookupBeer({
      brewery: 'Browar Testowy', name: 'Tounge Tingle / UTH', abv: 6,
      search: fakeSearch([r(4, 'Browar Testowy', 'UHT', 6)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('ABV difference 0.2 is inside tolerance → matched', async () => {
    const out = await lookupBeer({
      brewery: 'Artezan Brewery', name: 'UTH 15°', abv: 6.5,
      search: fakeSearch([r(6843957, 'Browar Artezan', 'UHT', 6.7, 52)]),
    });
    expect(out).toMatchObject({ kind: 'matched', result: { bid: 6843957 } });
  });

  test('uniqueness spans every brewery part of the lookup (a later part cannot hide an earlier rival)', async () => {
    const byQuery: Record<string, SearchResult[]> = {
      'Monsters Tounge Tingle': [r(1, 'Browar Monsters', 'Tongue Tingle', 6, 90)],
      'Monsters Taproom Tounge Tingle': [
        r(2, 'Browar Monsters', 'Tonuge Tingle', 6, 90),
        r(5, 'Browar Monsters', 'Tounge Tingle Red', 6, 70),
        r(6, 'Browar Monsters', 'Tounge Tingle Blue', 6, 70),
      ],
    };
    const out = await lookupBeer({
      brewery: 'Monsters Brewery x Monsters Taproom', name: 'Tounge Tingle', abv: 6,
      search: { search: async (query: string) => byQuery[query] ?? [] },
    });
    expect(out.kind).toBe('not_found');
  });

  test('an exact-identity candidate beside a moved-letter neighbour → not_found', async () => {
    const out = await lookupBeer({
      brewery: 'Browar Testowy', name: 'Silk', abv: 5,
      search: fakeSearch([
        r(10, 'Browar Testowy', 'Silk', 5, 500),
        r(11, 'Browar Testowy', 'Silk', 5, 450),
        r(12, 'Browar Testowy', 'Slik', 5, 30),
      ]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('#636: a different number is dropped before the pools, so no rescue', async () => {
    const out = await lookupBeer({
      brewery: 'Browar Testowy', name: 'UTH #2', abv: 6.5,
      search: fakeSearch([r(7, 'Browar Testowy', 'UHT #3', 6.5)]),
    });
    expect(out.kind).toBe('not_found');
  });

  test('a rescue vetoed by the series loop (Zero vs 6%) is not revived at the end of the lookup', async () => {
    const seriesPool = [
      r(1, 'Browar Testowy', 'UHT Zero #3 Mango', 6, 100),
      r(2, 'Browar Testowy', 'UTH Zero #3 Mango Red', 6, 80),
      r(3, 'Browar Testowy', 'UTH Zero #3 Mango Blue', 6, 80),
    ];
    const out = await lookupBeer({
      brewery: 'Browar Testowy', name: 'UTH Zero #3 Mango', abv: 6,
      search: { search: async (query: string) => (query === 'Testowy UTH Zero #3' ? seriesPool : []) },
    });
    expect(out.kind).toBe('not_found');
  });
});
