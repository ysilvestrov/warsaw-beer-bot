import { describe, it, expect, vi, afterEach } from 'vitest';
import { ENRICH_ORIGINS, initLocalDb, localDbSummary, requestEnrichPermission, setStatisticsEnabled, testConnection,
  type LocalDbNodes } from './options';
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

const N = ' ';

describe('localDbSummary (#924)', () => {
  it('an empty database says how to fill it', () => {
    expect(localDbSummary({ checkins: 0, beers: 0, lastSync: null })).toBe('Empty — open the popup and tap Sync my check-ins.');
  });

  it('counts are grouped and the last sync is the day of the ISO timestamp', () => {
    expect(localDbSummary({ checkins: 12407, beers: 9031, lastSync: '2026-11-07T10:05:00.000Z' }))
      .toBe(`12${N}407 check-ins · 9${N}031 beers · last sync 2026-11-07`);
  });

  it('one check-in of one beer reads in the singular', () => {
    expect(localDbSummary({ checkins: 1, beers: 1, lastSync: '2026-01-02T12:00:00.000Z' }))
      .toBe('1 check-in · 1 beer · last sync 2026-01-02');
  });

  it('the day is the local one: a sync just after local midnight is that day, not the UTC one before', () => {
    // Built from local fields, so the expectation holds in every time zone the tests run in.
    const justAfterMidnight = new Date(2026, 10, 8, 0, 5).toISOString();
    expect(localDbSummary({ checkins: 2, beers: 2, lastSync: justAfterMidnight })).toBe('2 check-ins · 2 beers · last sync 2026-11-08');
  });

  it('check-ins without a recorded sync (an interrupted first run) show the counts alone', () => {
    expect(localDbSummary({ checkins: 3, beers: 2, lastSync: null })).toBe('3 check-ins · 2 beers');
  });
});

describe('initLocalDb (#924)', () => {
  function nodes(): LocalDbNodes {
    document.body.innerHTML = `<section id="localDb" hidden><p id="localDbStats"></p>
      <button id="localDbClear" type="button">Clear local check-ins</button><p id="localDbStatus"></p></section>`;
    const q = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    return { section: q('localDb'), stats: q('localDbStats'), clear: q<HTMLButtonElement>('localDbClear'), status: q('localDbStatus') };
  }
  const full = { type: 'local-db:stats:ok', mode: 'local', checkins: 12407, beers: 9031, lastSync: '2026-11-07T10:05:00.000Z', username: 'alice' };
  const empty = { ...full, checkins: 0, beers: 0, lastSync: null };

  it('with a Telegram token the block stays hidden and asks the worker nothing', async () => {
    const n = nodes();
    const send = vi.fn(async () => full);
    await initLocalDb(n, true, send, () => true);
    expect(n.section.hidden).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('without a token the block shows the counts from the worker', async () => {
    const n = nodes();
    const send = vi.fn(async () => full);
    await initLocalDb(n, false, send, () => true);
    expect(n.section.hidden).toBe(false);
    expect(send).toHaveBeenCalledWith({ type: 'local-db:stats' });
    expect(n.stats.textContent).toBe(`12${N}407 check-ins · 9${N}031 beers · last sync 2026-11-07`);
  });

  it('saving a token hides the block; removing it shows the block with fresh counts', async () => {
    const n = nodes();
    const send = vi.fn(async () => full);
    const show = await initLocalDb(n, true, send, () => true);
    expect(n.section.hidden).toBe(true);
    await show(false);
    expect(n.section.hidden).toBe(false);
    expect(n.stats.textContent).toBe(`12${N}407 check-ins · 9${N}031 beers · last sync 2026-11-07`);
    await show(true);
    expect(n.section.hidden).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an unexpected reply (worker asleep, no answer) reads as empty', async () => {
    const n = nodes();
    await initLocalDb(n, false, vi.fn(async () => undefined), () => true);
    expect(n.stats.textContent).toBe('Empty — open the popup and tap Sync my check-ins.');
  });

  it('Clear asks with the exact count, clears on yes, and the summary follows', async () => {
    const n = nodes();
    let stored = true;
    const send = vi.fn(async (m: { type: string }) => {
      if (m.type === 'local-db:clear') { stored = false; return { type: 'local-db:cleared', ok: true }; }
      return stored ? full : empty;
    });
    const ask = vi.fn(() => true);
    await initLocalDb(n, false, send, ask);
    n.clear.click();
    await vi.waitFor(() => expect(n.status.textContent).toBe('Cleared.'));
    expect(ask).toHaveBeenCalledWith(`Delete 12${N}407 check-ins stored in this browser? Your Untappd account is not affected.`);
    expect(send.mock.calls.map(([m]) => m.type)).toEqual(['local-db:stats', 'local-db:clear', 'local-db:stats']);
    await vi.waitFor(() => expect(n.stats.textContent).toBe('Empty — open the popup and tap Sync my check-ins.'));
    expect(n.clear.disabled).toBe(false);
  });

  it('Clear on no sends nothing', async () => {
    const n = nodes();
    const send = vi.fn(async (_m: { type: string }) => full);
    await initLocalDb(n, false, send, () => false);
    n.clear.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(send.mock.calls.map(([m]) => m.type)).toEqual(['local-db:stats']);
    expect(n.status.textContent).toBe('');
  });

  it('a failed Clear says so and keeps the counts', async () => {
    const n = nodes();
    const send = vi.fn(async (m: { type: string }) => (m.type === 'local-db:clear' ? { type: 'local-db:cleared', ok: false } : full));
    await initLocalDb(n, false, send, () => true);
    n.clear.click();
    await vi.waitFor(() => expect(n.status.textContent).toBe('Could not clear the check-ins stored in this browser.'));
    expect(n.stats.textContent).toBe(`12${N}407 check-ins · 9${N}031 beers · last sync 2026-11-07`);
  });

  it('Clear on an empty database asks without a count', async () => {
    const n = nodes();
    const ask = vi.fn(() => false);
    await initLocalDb(n, false, vi.fn(async () => empty), ask);
    n.clear.click();
    expect(ask).toHaveBeenCalledWith('Delete the check-ins stored in this browser? Your Untappd account is not affected.');
  });
});
