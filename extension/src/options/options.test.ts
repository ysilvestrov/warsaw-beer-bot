import { describe, it, expect, vi, afterEach } from 'vitest';
import { ENRICH_ORIGINS, requestEnrichPermission, setStatisticsEnabled, testConnection } from './options';
import { authToken, getSettings, setSettings } from '../shared/config';
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

describe('setStatisticsEnabled (#923)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('switching off withholds the token at once and deletes the install', async () => {
    await setSettings({ installToken: 'wbi_1' });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await setStatisticsEnabled(false)).toBe('Statistics off.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getSettings()).toMatchObject({ installToken: '', installRegistration: false, installDeletionPending: false });
  });

  it('switching off with the server down says so, and requests go out without the token meanwhile', async () => {
    await setSettings({ installToken: 'wbi_1' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await setStatisticsEnabled(false)).toBe('Deletion not finished yet — will retry.');
    const s = await getSettings();
    expect(s).toMatchObject({ installToken: 'wbi_1', installDeletionPending: true });
    expect(authToken(s)).toBe('');
  });

  it('switching on registers a new install', async () => {
    await setSettings({ installRegistration: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ install_id: 'i', token: 'wbi_2' }), { status: 201 })));
    expect(await setStatisticsEnabled(true)).toBe('Statistics on.');
    expect((await getSettings()).installToken).toBe('wbi_2');
  });

  it('switching on with registration refused still reads on — the next start retries', async () => {
    await setSettings({ installRegistration: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    expect(await setStatisticsEnabled(true)).toBe('Statistics on.');
    expect(await getSettings()).toMatchObject({ installToken: '', installRegistration: true });
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
