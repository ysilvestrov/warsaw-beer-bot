import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEnrichFetch, handleEnrichCandidates, handleEnrichResult } from './index';

beforeEach(() => { vi.unstubAllGlobals(); });

describe('handleEnrichFetch', () => {
  it('returns null when the enrich toggle is off', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: false, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => true },
    });
    const out = await handleEnrichFetch({ type: 'enrich:fetch', url: 'https://untappd.com/search?q=x' });
    expect(out).toEqual({ type: 'enrich:fetch:ok', html: null });
  });

  it('fetches the URL when enabled + permission granted', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => true },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>raw</html>', { status: 200 })));
    const out = await handleEnrichFetch({ type: 'enrich:fetch', url: 'https://untappd.com/search?q=x' });
    expect(out).toEqual({ type: 'enrich:fetch:ok', html: '<html>raw</html>' });
  });

  it('returns null html when permission is absent', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } },
      permissions: { contains: async () => false },
    });
    const out = await handleEnrichFetch({ type: 'enrich:fetch', url: 'https://untappd.com/search?q=x' });
    expect(out.html).toBeNull();
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
      new Response(JSON.stringify({ candidates: [{ brewery: 'B', name: 'N', eligible: true, searchUrl: 'u' }] }), { status: 200 }),
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
    const out = await handleEnrichResult({ type: 'enrich:result', brewery: 'B', name: 'N', html: '<x>' });
    expect(out).toEqual({ type: 'enrich:result:ok', result: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the result payload when enabled + token present', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'matched', untappd_id: 5001 }), { status: 200 })));
    const out = await handleEnrichResult({ type: 'enrich:result', brewery: 'B', name: 'N', html: '<x>' });
    expect(out.result).toMatchObject({ status: 'matched', untappd_id: 5001 });
  });

  it('forwards pageUrl in the request body', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ enrichEnabled: true, token: 't', baseUrl: 'https://api' }) } } });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ status: 'not_found' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await handleEnrichResult({
      type: 'enrich:result', brewery: 'B', name: 'N', html: '<x>', pageUrl: 'https://beerfreak.org/p/x',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.pageUrl).toBe('https://beerfreak.org/p/x');
  });
});
