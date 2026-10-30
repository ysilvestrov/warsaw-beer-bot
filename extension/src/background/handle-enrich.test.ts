import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleEnrichCandidates, handleEnrichFetch, handleEnrichResult } from './index';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('handleEnrichFetch', () => {
  it('fetches Algolia JSON directly', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ hits: [{ beer_name: 'Guinness', bid: 100 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await handleEnrichFetch({
      type: 'enrich:fetch',
      algolia: {
        appId: 'TEST_APP',
        searchKey: 'TEST_KEY',
        indexName: 'beer',
        query: 'Guinness',
        hitsPerPage: 5,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith('https://TEST_APP-dsn.algolia.net/1/indexes/beer/query', expect.any(Object));
    expect(out.algolia?.hits).toHaveLength(1);
  });

  it('handles fetch errors gracefully and returns null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network error'); }));

    const out = await handleEnrichFetch({
      type: 'enrich:fetch',
      algolia: {
        appId: 'TEST_APP',
        searchKey: 'TEST_KEY',
        indexName: 'beer',
        query: 'Fail',
      },
    });

    expect(out.algolia).toBeNull();
  });
});

describe('handleEnrichCandidates', () => {
  it('generates direct Algolia candidates without 3rd party backend', async () => {
    const out = await handleEnrichCandidates({
      type: 'enrich:candidates',
      beers: [{ brewery: 'Arpus', name: 'DDH IPA' }],
    });

    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].brewery).toBe('Arpus');
    expect(out.candidates[0].name).toBe('DDH IPA');
    expect(out.candidates[0].algolia.query).toBe('Arpus DDH IPA');
  });
});

describe('handleEnrichResult', () => {
  it('resolves in-browser result without 3rd party server', async () => {
    const out = await handleEnrichResult({
      type: 'enrich:result',
      brewery: 'Arpus',
      name: 'DDH IPA',
      algolia: { hits: [] },
    });

    expect(out).toEqual({
      type: 'enrich:result:ok',
      result: { status: 'matched' },
    });
  });
});
