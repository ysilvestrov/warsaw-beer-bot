import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEnrichFetch, handleEnrichCandidates, handleEnrichResult } from './index';

beforeEach(() => { vi.unstubAllGlobals(); });

describe('handleEnrichFetch', () => {
  it('returns null when the enrich toggle is off', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: false, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => true },
    });
    const out = await handleEnrichFetch({
      type: 'enrich:fetch',
      algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'x', hitsPerPage: 5 },
    });
    expect(out).toEqual({ type: 'enrich:fetch:ok', algolia: null });
  });

  it('fetches Algolia JSON when enabled + permission granted', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => true },
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ hits: [{ bid: 7 }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await handleEnrichFetch({
      type: 'enrich:fetch',
      algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'x', hitsPerPage: 5 },
    });
    expect(out).toEqual({ type: 'enrich:fetch:ok', algolia: { hits: [{ bid: 7 }] } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://APP-dsn.algolia.net/1/indexes/beer/query');
    expect(init!.headers).toMatchObject({
      'X-Algolia-Application-Id': 'APP',
      'X-Algolia-API-Key': 'KEY',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init!.body as string)).toEqual({ query: 'x', hitsPerPage: 5 });
  });

  it('returns null Algolia JSON when permission is absent', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => false },
    });
    const out = await handleEnrichFetch({
      type: 'enrich:fetch',
      algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'x', hitsPerPage: 5 },
    });
    expect(out.algolia).toBeNull();
  });

  it('does not fetch Algolia when only Untappd permission is granted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } },
      permissions: {
        contains: async (request: { origins: string[] }) =>
          request.origins.length === 1 && request.origins[0] === 'https://untappd.com/*',
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await handleEnrichFetch({
      type: 'enrich:fetch',
      algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'x', hitsPerPage: 5 },
    });
    expect(out.algolia).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleEnrichCandidates', () => {
  it('returns [] when the toggle is off (no API call)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: false, token: 't', baseUrl: 'https://api' }) } } });
    vi.stubGlobal('fetch', fetchMock);
    const out = await handleEnrichCandidates({ type: 'enrich:candidates', beers: [{ brewery: 'B', name: 'N' }] });
    expect(out).toEqual({ type: 'enrich:candidates:ok', candidates: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] when there is no token', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: '', baseUrl: 'https://api' }) } } });
    const out = await handleEnrichCandidates({ type: 'enrich:candidates', beers: [{ brewery: 'B', name: 'N' }] });
    expect(out.candidates).toEqual([]);
  });

  it('returns the posted candidates when enabled + token present', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } } });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        candidates: [{
          brewery: 'B',
          name: 'N',
          eligible: true,
          algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'B N', hitsPerPage: 5 },
        }],
      }), { status: 200 }),
    ));
    const out = await handleEnrichCandidates({ type: 'enrich:candidates', beers: [{ brewery: 'B', name: 'N' }] });
    expect(out.candidates[0]).toMatchObject({ brewery: 'B', name: 'N', eligible: true });
  });
});

describe('handleEnrichResult', () => {
  it('returns null result when the toggle is off (no API call)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: false, token: 't', baseUrl: 'https://api' }) } } });
    vi.stubGlobal('fetch', fetchMock);
    const out = await handleEnrichResult({ type: 'enrich:result', brewery: 'B', name: 'N', algolia: { hits: [{ bid: 7 }] } });
    expect(out).toEqual({ type: 'enrich:result:ok', result: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the result payload when enabled + token present', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'matched', untappd_id: 5001 }), { status: 200 })));
    const out = await handleEnrichResult({ type: 'enrich:result', brewery: 'B', name: 'N', algolia: { hits: [{ bid: 5001 }] } });
    expect(out.result).toMatchObject({ status: 'matched', untappd_id: 5001 });
  });

  it('forwards pageUrl in the request body', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } } });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ status: 'not_found' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await handleEnrichResult({
      type: 'enrich:result', brewery: 'B', name: 'N', algolia: { hits: [] }, pageUrl: 'https://beerfreak.org/p/x',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.pageUrl).toBe('https://beerfreak.org/p/x');
    expect(body.algolia).toEqual({ hits: [] });
  });
});
