import { lookupBeer } from './untappd-lookup';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

function fakeSearch(fn: (q: string) => SearchResult[] | Promise<SearchResult[]>): BeerSearch {
  return { search: async (q) => fn(q) };
}

describe('#407 confirmation-only brewery typo rescue', () => {
  test('rescues the live Śmietanka row from a one-character brewery typo', async () => {
    const search = fakeSearch(() => [
      { bid: 878279, beer_name: 'Śmietanka', brewery_name: 'Jan Olbracht Rzemieślniczy', style: 'Cream Ale', abv: 5.6, global_rating: 3.4 },
    ]);

    const out = await lookupBeer({ brewery: 'Jan Olbrach', name: 'Śmietanka', abv: 5.6, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(878279);
  });

  test('rescues a distinctive exact multi-token name when ABV is missing', async () => {
    const search = fakeSearch(() => [
      { bid: 10, beer_name: 'Silver Lining', brewery_name: 'Raben Craft', style: 'Pale Ale', abv: null, global_rating: 3.5 },
    ]);

    const out = await lookupBeer({ brewery: 'Raven', name: 'Silver Lining', search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(10);
  });

  test('rejects a sole exact candidate when known ABVs contradict, including candidate ABV zero', async () => {
    const search = fakeSearch(() => [
      { bid: 4656416, beer_name: 'Wileńskie Niefiltrowane', brewery_name: 'Vilniaus Alus', style: 'Lager', abv: 0, global_rating: 3.1 },
    ]);

    const out = await lookupBeer({ brewery: 'VILINIAUS ALUS', name: 'Wileńskie Niefiltrowane', abv: 5.2, search });

    expect(out.kind).toBe('not_found');
  });

  test('rescues the live generic Hell row only with compatible ABV evidence', async () => {
    const search = fakeSearch(() => [
      { bid: 20175, beer_name: 'Hell', brewery_name: 'Keesmann Bräu', style: 'Lager - Helles', abv: 4.8, global_rating: 3.3 },
    ]);

    const out = await lookupBeer({ brewery: 'Kessman', name: 'Hell', abv: 4.8, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(20175);
  });

  test('keeps a generic one-token exact name unresolved without two known ABVs', async () => {
    const search = fakeSearch(() => [
      { bid: 20, beer_name: 'IPA', brewery_name: 'Raben Craft', style: 'IPA', abv: 6, global_rating: 3.5 },
    ]);

    const out = await lookupBeer({ brewery: 'Raven', name: 'IPA', search });

    expect(out.kind).toBe('not_found');
  });

  test.each([false, true])('keeps distinct exact-name candidates unresolved regardless of result order (reversed=%s)', async (reversed) => {
    const candidates: SearchResult[] = [
      { bid: 30, beer_name: 'Silver Lining', brewery_name: 'Raben Craft', style: 'Pale Ale', abv: 5, global_rating: 3.5 },
      { bid: 31, beer_name: 'Silver Lining', brewery_name: 'Raben Brewing', style: 'Pale Ale', abv: 8, global_rating: 3.8 },
    ];
    const search = fakeSearch(() => reversed ? [...candidates].reverse() : candidates);

    const out = await lookupBeer({ brewery: 'Raven', name: 'Silver Lining', abv: 5, search });

    expect(out.kind).toBe('not_found');
  });

  test('counts duplicate result rows with the same bid as one exact candidate', async () => {
    const candidate: SearchResult = {
      bid: 40, beer_name: 'Silver Lining', brewery_name: 'Raben Craft', style: 'Pale Ale', abv: 5, global_rating: 3.5,
    };
    const search = fakeSearch(() => [candidate, { ...candidate }]);

    const out = await lookupBeer({ brewery: 'Raven', name: 'Silver Lining', abv: 5, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(40);
  });

  test.each([false, true])('rejects conflicting duplicate rows regardless of result order (reversed=%s)', async (reversed) => {
    const candidates: SearchResult[] = [
      { bid: 41, beer_name: 'Silver Lining', brewery_name: 'Raben Craft', style: 'Pale Ale', abv: 5, global_rating: 3.5 },
      { bid: 41, beer_name: 'Silver Lining', brewery_name: 'Raben Craft', style: 'Pale Ale', abv: 8, global_rating: 3.5 },
    ];
    const search = fakeSearch(() => reversed ? [...candidates].reverse() : candidates);

    const out = await lookupBeer({ brewery: 'Raven', name: 'Silver Lining', abv: 5, search });

    expect(out.kind).toBe('not_found');
  });

  test.each([
    ['three edits', 'Raven', 'Raxxx Craft'],
    ['changed short token', 'AB Raven', 'AC Raven Craft'],
    ['inserted aligned token', 'Raven Craft', 'Raven New Craft'],
    ['transliteration', 'Броварня Ворон', 'Brovarnia Voron'],
    ['unrelated leading brewery token', 'Raven', 'Group Raben Craft'],
  ])('rejects %s as brewery typo evidence', async (_case, brewery, candidateBrewery) => {
    const search = fakeSearch(() => [
      { bid: 50, beer_name: 'Silver Lining', brewery_name: candidateBrewery, style: 'Pale Ale', abv: 5, global_rating: 3.5 },
    ]);

    const out = await lookupBeer({ brewery, name: 'Silver Lining', abv: 5, search });

    expect(out.kind).toBe('not_found');
  });

  test('keeps an ordinary strict match ahead of a typo-rescue candidate', async () => {
    const search = fakeSearch(() => [
      { bid: 60, beer_name: 'Silver Lining', brewery_name: 'Raven Brewery', style: 'Pale Ale', abv: 5, global_rating: 3.5 },
      { bid: 61, beer_name: 'Silver Lining', brewery_name: 'Raben Craft', style: 'Pale Ale', abv: 5, global_rating: 4 },
    ]);

    const out = await lookupBeer({ brewery: 'Raven', name: 'Silver Lining', abv: 5, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(60);
  });

  test('falls back after ambiguous identity evidence without issuing another query', async () => {
    const calledQueries: string[] = [];
    const search = fakeSearch((query) => {
      calledQueries.push(query);
      return [
        { bid: 70, beer_name: 'Other One', brewery_name: 'Elsewhere', style: 'Ale', abv: 5, global_rating: 3,
          alias_alt: ['Raven Silver Lining'] },
        { bid: 71, beer_name: 'Other Two', brewery_name: 'Elsewhere', style: 'Ale', abv: 5, global_rating: 3,
          alias_alt: ['Raven Silver Lining'] },
        { bid: 72, beer_name: 'Silver Lining', brewery_name: 'Raben Craft', style: 'Pale Ale', abv: 5, global_rating: 3.5 },
      ];
    });

    const out = await lookupBeer({ brewery: 'Raven', name: 'Silver Lining', abv: 5, search });

    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(72);
    expect(calledQueries).toHaveLength(1);
  });
});
