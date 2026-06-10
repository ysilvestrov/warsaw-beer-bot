import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEnrichFetch } from './index';

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
