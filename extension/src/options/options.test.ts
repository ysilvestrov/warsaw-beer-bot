import { describe, it, expect, vi, afterEach } from 'vitest';
import { ENRICH_ORIGINS, requestEnrichPermission, testConnection } from './options';
import * as client from '../api/client';
import { ApiError } from '../api/client';

afterEach(() => vi.restoreAllMocks());

describe('testConnection', () => {
  it('ok when health passes and a probe match succeeds', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(true);
    vi.spyOn(client, 'postMatch').mockResolvedValue([]);
    expect(await testConnection('https://api.test', 'tok')).toEqual({ ok: true });
  });

  it('fails with reason "health" when health is down', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(false);
    expect(await testConnection('https://api.test', 'tok')).toEqual({ ok: false, reason: 'health' });
  });

  it('fails with reason "unauthorized" when the probe match is 401', async () => {
    vi.spyOn(client, 'getHealth').mockResolvedValue(true);
    vi.spyOn(client, 'postMatch').mockRejectedValue(new ApiError('unauthorized'));
    expect(await testConnection('https://api.test', 'bad')).toEqual({ ok: false, reason: 'unauthorized' });
  });
});

describe('requestEnrichPermission', () => {
  it('requests both Untappd and Algolia origins for missing-beer enrichment', async () => {
    const request = vi.fn(async () => true);
    vi.stubGlobal('chrome', { permissions: { request } });

    expect(await requestEnrichPermission()).toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ENRICH_ORIGINS });
    expect(ENRICH_ORIGINS).toContain('https://untappd.com/*');
    expect(ENRICH_ORIGINS).toContain('https://*.algolia.net/*');

    vi.unstubAllGlobals();
  });
});
