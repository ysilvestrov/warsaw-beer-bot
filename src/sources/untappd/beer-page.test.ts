import { buildBeerPageUrl } from './beer-page';

describe('buildBeerPageUrl', () => {
  test('formats /beer/{bid}', () => {
    expect(buildBeerPageUrl(6645513)).toBe('https://untappd.com/beer/6645513');
  });

});

