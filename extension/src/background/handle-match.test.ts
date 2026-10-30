import { webcrypto } from 'node:crypto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { handleMatch, shopOf } from './index';
import { getSettings, setSettings } from '../shared/config';
import * as client from '../api/client';
import { ApiError } from '../api/client';
import type { MatchResult, RawBeer } from '../api/types';

function mkResult(name: string): MatchResult {
  return { raw: { brewery: 'B', name }, matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null , source: null, searched: true};
}

const CLIENT = { version: '9.9.9' };
const ANON_BINDING = { username: '', linkRevision: 0, credential: 'bfc0241d7945d212b82c069d6153ed25e97f7f351bdf09a7f098c5e3f2f839ee' };

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  await setSettings({ token: 'tok', baseUrl: 'https://api.test' });
  vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('handleMatch', () => {
  it('calls postMatch anonymously (empty token) when no token is set', async () => {
    await setSettings({ token: '', baseUrl: 'https://api.test' });
    const spy = vi.spyOn(client, 'postMatch').mockResolvedValue([mkResult('X')]);
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:ok', results: [{ ...mkResult('X'), cacheBinding: ANON_BINDING }] });
    expect(spy).toHaveBeenCalledWith('https://api.test', '', [{ brewery: 'B', name: 'X' }], client.DEFAULT_TIMEOUT_MS, CLIENT);
  });

  it('calls postMatch and returns results on success', async () => {
    const spy = vi.spyOn(client, 'postMatch').mockResolvedValue([mkResult('X')]);
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:ok', results: [{ ...mkResult('X'), cacheBinding: { username: 'bob', linkRevision: 1, credential: '8fcd28f26dd7e324a7a53831dfc51f99d8295dab948dca99e5ccf8a8a4d0cdbc' } }] });
    expect(spy).toHaveBeenCalledWith('https://api.test', 'tok', [{ brewery: 'B', name: 'X' }], client.DEFAULT_TIMEOUT_MS, CLIENT);
  });

  it('passes a match request through as one request', async () => {
    const cards: RawBeer[] = Array.from({ length: 250 }, (_, i) => ({ brewery: 'B', name: `n${i}` }));
    const spy = vi
      .spyOn(client, 'postMatch')
      .mockImplementation(async (_b, _t, part) => part.map((p) => mkResult(p.name)));
    const reply = await handleMatch({ type: 'match', cards });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://api.test', 'tok', cards, client.DEFAULT_TIMEOUT_MS, CLIENT);
    expect(reply).toMatchObject({ type: 'match:ok' });
    if (reply.type === 'match:ok') expect(reply.results).toHaveLength(250);
  });

  it('maps ApiError code to a match:err reply', async () => {
    vi.spyOn(client, 'postMatch').mockRejectedValue(new ApiError('unauthorized'));
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'unauthorized' });
  });

  it('maps an unknown throw to code server', async () => {
    vi.spyOn(client, 'postMatch').mockRejectedValue(new Error('boom'));
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'server' });
  });
});

describe('handleMatch — install token (#923)', () => {
  beforeEach(async () => { await setSettings({ token: '', installToken: 'wbi_1' }); });

  it('sends the install token and the shop, and binds the cache to no credential', async () => {
    const spy = vi.spyOn(client, 'postMatch').mockResolvedValue([mkResult('X')]);
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] }, 'beerfreak.pl');
    expect(spy).toHaveBeenCalledWith('https://api.test', 'wbi_1', [{ brewery: 'B', name: 'X' }], client.DEFAULT_TIMEOUT_MS,
      { version: '9.9.9', shop: 'beerfreak.pl' });
    expect(reply).toEqual({ type: 'match:ok', results: [{ ...mkResult('X'), cacheBinding: ANON_BINDING }] });
  });

  it('a 401 on the install token forgets it and asks the same cards again anonymously', async () => {
    const spy = vi.spyOn(client, 'postMatch')
      .mockRejectedValueOnce(new ApiError('unauthorized'))
      .mockResolvedValueOnce([mkResult('X')]);
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['wbi_1', '']);
    expect(reply).toEqual({ type: 'match:ok', results: [{ ...mkResult('X'), cacheBinding: ANON_BINDING }] });
    expect((await getSettings()).installToken).toBe('');
  });

  it('a pending deletion sends no install token', async () => {
    await setSettings({ installDeletionPending: true });
    const spy = vi.spyOn(client, 'postMatch').mockResolvedValue([mkResult('X')]);
    await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(spy.mock.calls[0][1]).toBe('');
  });

  it('a 401 on a Telegram token is still unauthorized, with no anonymous retry', async () => {
    await setSettings({ token: 'tok' });
    const spy = vi.spyOn(client, 'postMatch').mockRejectedValue(new ApiError('unauthorized'));
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'unauthorized' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await getSettings()).installToken).toBe('wbi_1');
  });

  it('a non-401 failure on the install token keeps it', async () => {
    vi.spyOn(client, 'postMatch').mockRejectedValue(new ApiError('server'));
    expect(await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] })).toEqual({ type: 'match:err', code: 'server' });
    expect((await getSettings()).installToken).toBe('wbi_1');
  });
});

describe('shopOf', () => {
  it('is the hostname of the tab that sent the cards', () => {
    expect(shopOf('https://www.beerfreak.pl/sklep/piwo?page=2')).toBe('www.beerfreak.pl');
  });

  it('a hostname of exactly 64 characters is sent', () => {
    const host = `${'a'.repeat(61)}.pl`;
    expect(shopOf(`https://${host}/`)).toBe(host);
  });

  it('a hostname over 64 characters is not sent — the server would reject the whole request', () => {
    expect(shopOf(`https://${'a'.repeat(62)}.pl/`)).toBeUndefined();
  });

  it('no sender tab, or no URL, is no shop', () => {
    expect(shopOf(undefined)).toBeUndefined();
    expect(shopOf('not a url')).toBeUndefined();
  });
});
