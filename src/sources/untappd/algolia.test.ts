import { describe, it, expect } from 'vitest';
import { parseAlgoliaResponse, extractAlgoliaKeys, createAlgoliaSearch } from './algolia';
import { HttpError } from '../http';

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

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createAlgoliaSearch (direct)', () => {
  it('POSTs query to the index and returns mapped hits', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonRes({ hits: [{ bid: 7, beer_name: 'B', brewery_name: 'Br' }], nbHits: 1 });
    }) as unknown as typeof fetch;
    const s = createAlgoliaSearch({ appId: 'APP', searchKey: 'KEY', fetchImpl });
    const out = await s.search('hazy ipa');
    expect(out).toEqual([{ bid: 7, beer_name: 'B', brewery_name: 'Br', style: null, abv: null, global_rating: null }]);
    expect(calls[0].url).toBe('https://APP-dsn.algolia.net/1/indexes/beer/query');
    expect((calls[0].init.headers as Record<string, string>)['X-Algolia-Application-Id']).toBe('APP');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ query: 'hazy ipa', hitsPerPage: 5 });
  });

  it('returns [] for a genuine empty result (200, nbHits 0)', async () => {
    const fetchImpl = (async () => jsonRes({ hits: [], nbHits: 0 })) as unknown as typeof fetch;
    const s = createAlgoliaSearch({ appId: 'A', searchKey: 'K', fetchImpl });
    expect(await s.search('nope')).toEqual([]);
  });

  it('throws HttpError(500) on 5xx (→ transient upstream)', async () => {
    const fetchImpl = (async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    const s = createAlgoliaSearch({ appId: 'A', searchKey: 'K', fetchImpl });
    await expect(s.search('x')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('createAlgoliaSearch (403 handling)', () => {
  it('refreshes keys on 403 and retries direct with the new key', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)['X-Algolia-API-Key'];
      seen.push(key);
      if (key === 'OLD') return new Response('forbidden', { status: 403 });
      return jsonRes({ hits: [{ bid: 1, beer_name: 'B', brewery_name: 'Br' }], nbHits: 1 });
    }) as unknown as typeof fetch;
    const s = createAlgoliaSearch({
      appId: 'A', searchKey: 'OLD', fetchImpl,
      refreshKeys: async () => ({ appId: 'A', searchKey: 'NEW' }),
    });
    const out = await s.search('x');
    expect(out).toHaveLength(1);
    expect(seen).toEqual(['OLD', 'NEW']);
  });

  it('falls back to the proxy when the key did not change', async () => {
    let direct = 0;
    const fetchImpl = (async (_url: string, init: RequestInit & { dispatcher?: unknown }) => {
      if (!init.dispatcher) { direct++; return new Response('forbidden', { status: 403 }); }
      return jsonRes({ hits: [{ bid: 2, beer_name: 'B', brewery_name: 'Br' }], nbHits: 1 });
    }) as unknown as typeof fetch;
    const s = createAlgoliaSearch({
      appId: 'A', searchKey: 'SAME', proxyUrl: 'user:pass@host:1', fetchImpl,
      refreshKeys: async () => ({ appId: 'A', searchKey: 'SAME' }),
    });
    const out = await s.search('x');
    expect(out).toHaveLength(1);
    expect(direct).toBe(1);
  });

  it('throws HttpError(403) when direct, refresh, and proxy all fail', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    const s = createAlgoliaSearch({
      appId: 'A', searchKey: 'OLD', proxyUrl: 'user:pass@host:1', fetchImpl,
      refreshKeys: async () => ({ appId: 'A', searchKey: 'NEW' }),
    });
    await expect(s.search('x')).rejects.toMatchObject({ name: 'HttpError', status: 403 });
  });
});

describe('hydrateByBid (#384)', () => {
  it('sends one batched objectID request and maps results positionally', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({
        results: [
          { bid: 6648348, beer_name: 'Tomatøl:BULDAK BULGOGI', brewery_name: 'Mad Brew',
            brewery_alias: ['madbrew'], beer_slug: 'mad-brew-tomatol-buldak-bulgogi',
            type_name: 'Gose', beer_abv: 4.2, rating_score: 4.06 },
          null,
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const search = createAlgoliaSearch({ appId: 'APP', searchKey: 'KEY', fetchImpl, minGapMs: 0 });
    const out = await search.hydrateByBid([6648348, 999999999]);

    expect(captured!.url).toContain('/1/indexes/*/objects');
    expect(captured!.body).toEqual({
      requests: [
        { indexName: 'beer', objectID: '6648348' },
        { indexName: 'beer', objectID: '999999999' },
      ],
    });
    expect(out.get(6648348)).toEqual({
      bid: 6648348,
      beer_name: 'Tomatøl:BULDAK BULGOGI',
      brewery_name: 'Mad Brew',
      brewery_alias: ['madbrew'],
      beer_slug: 'mad-brew-tomatol-buldak-bulgogi',
      style: 'Gose',
      abv: 4.2,
      global_rating: 4.06,
    });
    expect(out.has(999999999)).toBe(false);
  });

  it('returns an empty map for an empty input without calling the network', async () => {
    const fetchImpl = (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch;
    const search = createAlgoliaSearch({ appId: 'APP', searchKey: 'KEY', fetchImpl, minGapMs: 0 });
    expect((await search.hydrateByBid([])).size).toBe(0);
  });
});
