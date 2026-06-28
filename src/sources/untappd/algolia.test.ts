import { describe, it, expect } from 'vitest';
import { parseAlgoliaResponse, extractAlgoliaKeys } from './algolia';

const HIT = {
  bid: 5469263,
  beer_name: 'After Hours: Rose Wild Ale',
  brewery_name: 'PINTA Barrel Brewing',
  type_name: 'Wild Ale - Other',
  beer_abv: 5.7,
  rating_score: 3.89,
};

describe('parseAlgoliaResponse', () => {
  it('maps hits to SearchResult fields', () => {
    const out = parseAlgoliaResponse({ hits: [HIT], nbHits: 1 });
    expect(out).toEqual([
      { bid: 5469263, beer_name: 'After Hours: Rose Wild Ale', brewery_name: 'PINTA Barrel Brewing', style: 'Wild Ale - Other', abv: 5.7, global_rating: 3.89 },
    ]);
  });

  it('returns [] for empty hits', () => {
    expect(parseAlgoliaResponse({ hits: [], nbHits: 0 })).toEqual([]);
  });

  it('coerces missing/invalid numeric fields to null', () => {
    const out = parseAlgoliaResponse({ hits: [{ bid: 1, beer_name: 'X', brewery_name: 'Y' }], nbHits: 1 });
    expect(out[0]).toEqual({ bid: 1, beer_name: 'X', brewery_name: 'Y', style: null, abv: null, global_rating: null });
  });

  it('skips hits without a numeric bid', () => {
    expect(parseAlgoliaResponse({ hits: [{ beer_name: 'X', brewery_name: 'Y' }], nbHits: 1 })).toEqual([]);
  });
});

describe('extractAlgoliaKeys', () => {
  it('pulls appId and searchKey from inline JS', () => {
    const html = `<script>var c={ applicationID: '9WBO4RQ3HO', apiKey: '1d347324d67ec472bb7132c66aead485' };</script>`;
    expect(extractAlgoliaKeys(html)).toEqual({ appId: '9WBO4RQ3HO', searchKey: '1d347324d67ec472bb7132c66aead485' });
  });

  it('also matches JSON-style appId/searchKey', () => {
    const html = `"appId":"9WBO4RQ3HO","searchKey":"1d347324d67ec472bb7132c66aead485"`;
    expect(extractAlgoliaKeys(html)).toEqual({ appId: '9WBO4RQ3HO', searchKey: '1d347324d67ec472bb7132c66aead485' });
  });

  it('returns null when keys are absent', () => {
    expect(extractAlgoliaKeys('<html>nothing here</html>')).toBeNull();
  });
});
