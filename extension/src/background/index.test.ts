import { webcrypto } from 'node:crypto';
import * as cacheStore from '../cache/store';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  feedUrl, handleCacheSet, handleCacheSetMany, handleCacheSetIfMatching,
  handleCheckinSyncStart, handleCheckinSyncStatus, handleCheckinSyncStop, handleMatch,
} from './index';
import { setSettings } from '../shared/config';
import { CHECK_ALARM, INTENT_KEY, WATCHDOG_ALARM } from './sync-scheduler';
import { getCached } from '../cache/store';
import type { MatchResult } from '../api/types';
import * as client from '../api/client';

const cacheBinding = { username: 'bob', linkRevision: 1,
  credential: '8fcd28f26dd7e324a7a53831dfc51f99d8295dab948dca99e5ccf8a8a4d0cdbc' };

// #934: the sync status, the scheduler's intent and the settings share chrome.storage.local.
const localStore = new Map<string, unknown>();
// A signed-in profile page: the step checks the session on page one (#934).
const signedIn = (name: string) => `<html><a data-href=":user/profile" href="/user/${name}">My Profile</a></html>`;
const FEED = signedIn('bob');

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  localStore.clear();
  Object.assign(chrome.storage, {
    local: {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
        const defaults = keys !== null && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
        const ks = keys === undefined ? [...localStore.keys()]
          : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(defaults);
        const out: Record<string, unknown> = {};
        for (const k of ks) {
          if (localStore.has(k)) out[k] = localStore.get(k);
          else if (k in defaults) out[k] = defaults[k];
        }
        return out;
      }),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) localStore.set(key, value);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) localStore.delete(k);
      }),
    },
  });
  await setSettings({ token: 'tok', baseUrl: 'https://api.test' });
  vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('feedUrl', () => {
  it('page 1 (null cursor) is the full profile page', () => {
    expect(feedUrl('ysilvestrov', null)).toBe('https://untappd.com/user/ysilvestrov');
  });

  it('older pages use the more_feed XHR endpoint, not a ?max_id= query', () => {
    expect(feedUrl('ysilvestrov', '1577238079')).toBe(
      'https://untappd.com/profile/more_feed/ysilvestrov/1577238079?v2=true',
    );
  });

  it('encodes the username', () => {
    expect(feedUrl('a b/c', null)).toBe('https://untappd.com/user/a%20b%2Fc');
  });
});

describe('cache mutation queue', () => {
  const orphan: MatchResult = {
    raw: { brewery: 'B', name: 'N' },
    matched_beer: { id: 4, brewery: 'B', name: 'N', rating_global: null, untappd_id: null },
    is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true, cacheBinding,
  };

  it('does not let an older enrichment overwrite a newer match', async () => {
    const refreshed: MatchResult = {
      ...orphan,
      matched_beer: { id: 9, brewery: 'B', name: 'Newer', rating_global: 4.6, untappd_id: 999 },
    };
    const found: MatchResult = {
      ...orphan,
      matched_beer: { ...orphan.matched_beer!, untappd_id: 6648348, rating_global: 3.9 },
    };
    await handleCacheSet('k0', orphan);
    await handleCacheSet('k0', refreshed);

    expect(await handleCacheSetIfMatching('k0', orphan, found)).toBe(false);
    expect(await getCached('k0')).toEqual(refreshed);
  });

  it('writes an overlay response as one queued batch', async () => {
    const second = { ...orphan, raw: { brewery: 'B', name: 'Other' } };

    await handleCacheSetMany([
      { key: 'k0', result: orphan },
      { key: 'k1', result: second },
    ]);

    expect(await getCached('k0')).toEqual(orphan);
    expect(await getCached('k1')).toEqual(second);
  });
});

describe('handleMatch', () => {
  it('posts a maximum-size message once', async () => {
    const orphan: MatchResult = {
      raw: { brewery: 'B', name: '0' },
      matched_beer: null,
      is_drunk: false,
      drunk_uncertain: false,
      user_rating: null,
      source: null,
      searched: true,
    };
    const cards = Array.from({ length: 200 }, (_, i) => ({ brewery: 'B', name: String(i) }));
    vi.spyOn(client, 'postMatch').mockResolvedValue([orphan]);

    await expect(handleMatch({ type: 'match', cards })).resolves.toEqual({ type: 'match:ok', results: [{ ...orphan, cacheBinding }] });
    expect(client.postMatch).toHaveBeenCalledTimes(1);
    expect(client.postMatch).toHaveBeenCalledWith('https://api.test', 'tok', cards, client.DEFAULT_TIMEOUT_MS, { version: '9.9.9' });
  });
});

describe('check-in sync controls', () => {
  it('stops the active run and records a cancelled outcome', async () => {
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    let markFeedStarted!: () => void;
    const feedStarted = new Promise<void>((resolve) => { markFeedStarted = resolve; });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      markFeedStarted();
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    await handleCheckinSyncStart();
    await feedStarted;
    expect(await handleCheckinSyncStop()).toEqual({ type: 'checkin-sync:stopped', stopped: true });

    await vi.waitFor(async () => {
      expect((await handleCheckinSyncStatus()).outcome).toBe('cancelled');
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it('aborts an in-flight backend page submit', async () => {
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    let markBackendStarted!: () => void;
    const backendStarted = new Promise<void>((resolve) => { markBackendStarted = resolve; });
    let rejectBackend: ((reason?: unknown) => void) | undefined;
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://untappd.com/')) {
        return Promise.resolve(new Response(FEED, { status: 200 }));
      }
      markBackendStarted();
      return new Promise<Response>((_resolve, reject) => {
        rejectBackend = reject;
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await handleCheckinSyncStart();
    await backendStarted;
    await handleCheckinSyncStop();

    try {
      await vi.waitFor(async () => {
        expect((await handleCheckinSyncStatus()).outcome).toBe('cancelled');
      }, { timeout: 300 });
    } finally {
      rejectBackend?.(new DOMException('Test cleanup', 'AbortError'));
    }
  });

  it('clears a stale persisted running state when no live run exists', async () => {
    await chrome.storage.local.set({
      checkinSync: {
        running: true, serverCount: 12, profileTotal: 100, mergedThisRun: 4, outcome: null, complete: false,
        binding: { username: 'bob', linkRevision: 1, token: 'tok', baseUrl: 'https://api.test' },
      },
    });

    expect(await handleCheckinSyncStop()).toEqual({ type: 'checkin-sync:stopped', stopped: true });
    expect(await handleCheckinSyncStatus()).toMatchObject({
      running: false, serverCount: 12, profileTotal: 100, mergedThisRun: 4, outcome: 'cancelled', complete: false,
    });
  });

  it('reserves startup before awaiting storage so a retry cannot launch a duplicate run', async () => {
    await chrome.storage.local.set({
      checkinSync: {
        running: true, serverCount: 12, profileTotal: 100, mergedThisRun: 4, outcome: null, complete: false,
        binding: { username: 'bob', linkRevision: 1, token: 'tok', baseUrl: 'https://api.test' },
      },
    });
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<Record<string, unknown>>((resolve) => {
      releaseFirstRead = () => resolve({});
    });
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(async () => firstRead);
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(FEED, { status: 200 })));
    vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({
      merged: 0, alreadyKnown: 25, pageSize: 25, nextMaxId: '11', nextCursor: null, profileTotal: 100, serverCount: 12, complete: false,
    });

    const firstStart = handleCheckinSyncStart();
    await Promise.resolve();
    let retrySettled = false;
    const retryStart = handleCheckinSyncStart().then((reply) => {
      retrySettled = true;
      return reply;
    });
    await Promise.resolve();
    const settledBeforeFirstStartFinished = retrySettled;
    const statusDuringStartup = await handleCheckinSyncStatus();
    releaseFirstRead();
    await firstStart;
    const retryReply = await retryStart;
    await vi.waitFor(async () => {
      expect((await handleCheckinSyncStatus()).running).toBe(false);
    });

    expect(settledBeforeFirstStartFinished).toBe(false);
    expect(statusDuringStartup).toMatchObject({ running: true, outcome: null });
    expect(retryReply).toEqual({ type: 'checkin-sync:started', alreadyRunning: true });
  });

  it('replies after an initial status write fails and allows a later start', async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('local storage unavailable'));
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(FEED, { status: 200 })));
    vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({
      merged: 1, alreadyKnown: 24, pageSize: 25, nextMaxId: null, nextCursor: null,
      profileTotal: 100, serverCount: 13, complete: true,
    });

    const firstStart = handleCheckinSyncStart();
    const retryStart = handleCheckinSyncStart();

    await expect(firstStart).resolves.toEqual({ type: 'checkin-sync:started', alreadyRunning: false });
    await expect(retryStart).resolves.toEqual({ type: 'checkin-sync:started', alreadyRunning: false });

    await expect(handleCheckinSyncStart()).resolves.toEqual({
      type: 'checkin-sync:started', alreadyRunning: false,
    });
    await vi.waitFor(async () => {
      expect(client.postCheckinSyncPage).toHaveBeenCalledTimes(1);
      expect(await handleCheckinSyncStatus()).toMatchObject({ running: false, outcome: 'done' });
    });
  });

  it('preserves a successful outcome when its first terminal status write fails', async () => {
    let rejectedDoneWrite = false;
    vi.mocked(chrome.storage.local.set).mockImplementation(async (values: Record<string, unknown>) => {
      const status = values.checkinSync as { outcome?: unknown } | undefined;
      if (status?.outcome === 'done' && !rejectedDoneWrite) {
        rejectedDoneWrite = true;
        throw new Error('session storage unavailable');
      }
      for (const [key, value] of Object.entries(values)) localStore.set(key, value);
    });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(FEED, { status: 200 })));
    vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({
      // #587: `complete` тепер похідне від збігу лічильників — profileTotal:13 тут
      // навмисно дорівнює serverCount, щоб out.complete вийшло true.
      merged: 1, alreadyKnown: 24, pageSize: 25, nextMaxId: null, nextCursor: null,
      profileTotal: 13, serverCount: 13, complete: true,
    });

    await handleCheckinSyncStart();

    await vi.waitFor(async () => {
      expect(rejectedDoneWrite).toBe(true);
      expect(await handleCheckinSyncStatus()).toMatchObject({
        running: false, serverCount: 13, mergedThisRun: 1, outcome: 'done', complete: true,
      });
    });
    const writtenOutcomes = vi.mocked(chrome.storage.local.set).mock.calls.map(([values]) =>
      ((values as Record<string, unknown>).checkinSync as { outcome?: unknown } | undefined)?.outcome);
    expect(writtenOutcomes).not.toContain('error');
  });

  it('writes the terminal status through the scheduler report when the step\'s own writes keep failing', async () => {
    let rejectedDoneWrites = 0;
    vi.mocked(chrome.storage.local.set).mockImplementation(async (values: Record<string, unknown>) => {
      const status = values.checkinSync as { outcome?: unknown } | undefined;
      if (status?.outcome === 'done' && rejectedDoneWrites < 2) {
        rejectedDoneWrites++;
        throw new Error('session storage unavailable');
      }
      for (const [key, value] of Object.entries(values)) localStore.set(key, value);
    });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(FEED, { status: 200 })));
    vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({
      merged: 1, alreadyKnown: 24, pageSize: 25, nextMaxId: null, nextCursor: null,
      profileTotal: 100, serverCount: 13, complete: true,
    });

    await handleCheckinSyncStart();

    await vi.waitFor(() => expect(rejectedDoneWrites).toBe(2));
    await vi.waitFor(async () => {
      expect(await handleCheckinSyncStatus()).toMatchObject({ running: false, outcome: 'done', serverCount: 13 });
    });
    await expect(handleCheckinSyncStart()).resolves.toEqual({
      type: 'checkin-sync:started', alreadyRunning: false,
    });
    await vi.waitFor(() => expect(client.postCheckinSyncPage).toHaveBeenCalledTimes(2));
  });

  it('wakes the delay when stopped instead of fetching another page', async () => {
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    const fetchMock = vi.fn(async () => new Response(FEED, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const submitPage = vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({
      merged: 1, alreadyKnown: 0, pageSize: 25, nextMaxId: '11', nextCursor: '11', profileTotal: 100, serverCount: 13, complete: false,
    });

    await handleCheckinSyncStart();
    await vi.waitFor(() => expect(submitPage).toHaveBeenCalledTimes(1));
    await handleCheckinSyncStop();

    await vi.waitFor(async () => {
      expect((await handleCheckinSyncStatus()).outcome).toBe('cancelled');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe('#611 cached sync reports', () => {
  const binding = { username: 'bob', linkRevision: 1, token: 'tok', baseUrl: 'https://api.test' };
  const completed = { running: false, serverCount: 100, profileTotal: 100, mergedThisRun: 5, outcome: 'done', complete: true, binding };
  it.each([
    { username: 'other', linkRevision: 2 }, { username: 'bob', linkRevision: 3 },
  ])('never reuses A completion for $username revision $linkRevision', async current => {
    await chrome.storage.local.set({ checkinSync: completed });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ ...current, deepest_max_id: null, serverCount: 0, profileTotal: null, complete: false });
    await handleCacheSet('old-personal', { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
      is_drunk: true, drunk_uncertain: false, user_rating: 4, source: 'exact', searched: true, cacheBinding });
    expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
      serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'account_changed', complete: false });
    expect(await getCached('old-personal')).toBe(null);
  });
  it('retains a verified report without exposing credentials in the popup reply', async () => {
    await chrome.storage.local.set({ checkinSync: completed });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'BOB', linkRevision: 1, deepest_max_id: null, serverCount: 100, profileTotal: null, complete: false });
    expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
      serverCount: 100, profileTotal: 100, mergedThisRun: 5, outcome: 'done', complete: true });
  });
  it('cannot establish a cached completion when current state is unavailable', async () => {
    await chrome.storage.local.set({ checkinSync: completed });
    vi.spyOn(client, 'getCheckinSyncState').mockRejectedValue(new Error('offline'));
    expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
      serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'error', complete: false });
  });
  it('discards an old report without a binding', async () => {
    const { binding: _binding, ...legacy } = completed;
    await chrome.storage.local.set({ checkinSync: legacy });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'bob', linkRevision: 1, deepest_max_id: null, serverCount: 12, profileTotal: null, complete: false });
    expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
      serverCount: 12, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false });
  });
  it('does not reuse a report after credentials change, even with the same username and revision', async () => {
    await chrome.storage.local.set({ checkinSync: completed });
    await setSettings({ token: 'another-user' });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'bob', linkRevision: 1, deepest_max_id: null, serverCount: 0, profileTotal: null, complete: false });
    expect(await handleCheckinSyncStatus()).toMatchObject({ serverCount: 0, mergedThisRun: 0, complete: false, outcome: 'account_changed' });
  });
});

test('a delayed status validation does not replace a completed run with an obsolete running report', async () => {
  const state = { username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 13 };
  let releaseValidation!: (s: typeof state) => void;
  const validation = new Promise<typeof state>(resolve => { releaseValidation = resolve; });
  vi.spyOn(client, 'getCheckinSyncState').mockResolvedValueOnce(state).mockImplementationOnce(() => validation);
  vi.stubGlobal('fetch', async () => new Response(FEED));
  let releasePage!: (s: never) => void;
  const page = new Promise<never>(resolve => { releasePage = resolve; });
  const submit = vi.spyOn(client, 'postCheckinSyncPage').mockImplementationOnce(() => page);
  await handleCheckinSyncStart();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const reading = handleCheckinSyncStatus();
  await vi.waitFor(() => expect(client.getCheckinSyncState).toHaveBeenCalledTimes(2));
  releasePage({ merged: 1, alreadyKnown: 0, pageSize: 1, nextMaxId: null, nextCursor: null,
    profileTotal: 13, serverCount: 13, complete: false } as never);
  await vi.waitFor(() => expect(localStore.get('checkinSync')).toMatchObject({ outcome: 'done' }));
  releaseValidation(state);
  expect(await reading).toEqual({ type: 'checkin-sync:status:ok', running: false,
    serverCount: 13, profileTotal: 13, mergedThisRun: 1, outcome: 'done', complete: true });
});

test('queued progress and a terminal reply from A cannot restore A after a verified switch to B', async () => {
  const a = { username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 99, profileTotal: 100 };
  const b = { username: 'other', linkRevision: 2, deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null };
  vi.spyOn(client, 'getCheckinSyncState').mockResolvedValueOnce(a).mockResolvedValue(b);
  vi.stubGlobal('fetch', async () => new Response(FEED));
  let releasePage!: (s: never) => void;
  const page = new Promise<never>(resolve => { releasePage = resolve; });
  const submit = vi.spyOn(client, 'postCheckinSyncPage').mockImplementationOnce(() => page);
  await handleCheckinSyncStart();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(await handleCheckinSyncStatus()).toMatchObject({ serverCount: 0, complete: false, outcome: 'account_changed' });
  releasePage({ merged: 1, alreadyKnown: 0, pageSize: 1, nextMaxId: null, nextCursor: null,
    profileTotal: 100, serverCount: 100, complete: false } as never);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
    serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'account_changed', complete: false });
  expect(localStore.get('checkinSync')).toMatchObject({ binding: { username: 'other', linkRevision: 2 }, serverCount: 0, complete: false });
});


test('starting B directly clears cached A personal matches before reporting B progress', async () => {
  await chrome.storage.local.set({ checkinSync: { running: false, serverCount: 100, profileTotal: 100,
    mergedThisRun: 5, outcome: 'done', complete: true,
    binding: { username: 'bob', linkRevision: 1, token: 'tok', baseUrl: 'https://api.test' } } });
  await handleCacheSet('old-personal', { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
    is_drunk: true, drunk_uncertain: false, user_rating: 4, source: 'exact', searched: true, cacheBinding });
  vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'other', linkRevision: 2,
    deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null });
  vi.stubGlobal('fetch', async () => new Response(signedIn('other')));
  vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({ merged: 0, alreadyKnown: 0, pageSize: 0,
    nextMaxId: null, nextCursor: null, profileTotal: null, serverCount: 0, complete: false });
  await handleCheckinSyncStart();
  await vi.waitFor(() => expect(localStore.get('checkinSync')).toMatchObject({ running: false, outcome: 'done' }));
  expect(await getCached('old-personal')).toBe(null);
});

test('a start without credentials cannot retain an earlier completion', async () => {
  await chrome.storage.local.set({ checkinSync: { running: false, serverCount: 100, profileTotal: 100,
    mergedThisRun: 5, outcome: 'done', complete: true,
    binding: { username: 'bob', linkRevision: 1, token: 'tok', baseUrl: 'https://api.test' } } });
  await handleCacheSet('old-personal', { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
    is_drunk: true, drunk_uncertain: false, user_rating: 4, source: 'exact', searched: true, cacheBinding });
  await setSettings({ token: '' });
  await handleCheckinSyncStart();
  expect(await getCached('old-personal')).toBe(null);
  expect(localStore.get('checkinSync')).toEqual({ running: false, serverCount: 0, profileTotal: null,
    mergedThisRun: 0, outcome: 'error', complete: false });
});

test('clearing credentials invalidates cached personal data and aborts an active old-token sync', async () => {
  let resolveFeed!: (response: Response) => void;
  const feed = new Promise<Response>(resolve => { resolveFeed = resolve; });
  const fetchFeed = vi.fn((_url: string, _init: RequestInit) => feed);
  vi.stubGlobal('fetch', fetchFeed);
  const post = vi.spyOn(client, 'postCheckinSyncPage');
  await handleCheckinSyncStart();
  await vi.waitFor(() => expect(fetchFeed).toHaveBeenCalledTimes(1));
  await handleCacheSet('old-personal', { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
    is_drunk: true, drunk_uncertain: false, user_rating: 4, source: 'exact', searched: true, cacheBinding });
  const signal = fetchFeed.mock.calls[0][1].signal!;
  await setSettings({ token: '' });
  expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
    serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'error', complete: false });
  const aborted = signal.aborted;
  const cached = await getCached('old-personal');
  resolveFeed(new Response('<html></html>'));
  await handleCheckinSyncStop();
  await vi.waitFor(async () => expect(await handleCheckinSyncStop()).toEqual({ type: 'checkin-sync:stopped', stopped: false }));
  expect(aborted).toBe(true);
  expect(cached).toBe(null);
  expect(post).not.toHaveBeenCalled();
  expect(localStore.get('checkinSync')).toEqual({ running: false, serverCount: 0, profileTotal: null,
    mergedThisRun: 0, outcome: 'error', complete: false });
});


test('a delayed old-token match is not returned after credentials are removed', async () => {
  let resolveMatch!: (results: MatchResult[]) => void;
  const pending = new Promise<MatchResult[]>(resolve => { resolveMatch = resolve; });
  const post = vi.spyOn(client, 'postMatch').mockReturnValue(pending);
  const response = handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'N' }] });
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  await setSettings({ token: '' });
  await handleCheckinSyncStatus();
  resolveMatch([{ raw: { brewery: 'B', name: 'N' }, matched_beer: null,
    is_drunk: true, drunk_uncertain: false, user_rating: 0, source: 'exact', searched: true, cacheBinding }]);
  expect(await response).toEqual({ type: 'match:err', code: 'unauthorized' });
});

test('late personal cache writes cannot repopulate cleared credentials, while global matches still cache', async () => {
  const personal: MatchResult = { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
    is_drunk: true, drunk_uncertain: false, user_rating: 0, source: 'exact', searched: true, cacheBinding };
  const global: MatchResult = { ...personal, is_drunk: false, user_rating: null,
    cacheBinding: { username: '', linkRevision: 0, credential: 'bfc0241d7945d212b82c069d6153ed25e97f7f351bdf09a7f098c5e3f2f839ee' } };
  await handleCacheSet('conditional', personal);
  await setSettings({ token: '' });
  await handleCheckinSyncStatus();
  await handleCacheSet('single', personal);
  await handleCacheSetMany([{ key: 'batch-personal', result: personal }, { key: 'global', result: global }]);
  await cacheStore.setCached('conditional', personal);
  expect(await handleCacheSetIfMatching('conditional', personal, personal)).toBe(false);
  expect(await getCached('single')).toBe(null);
  expect(await getCached('batch-personal')).toBe(null);
  expect(await getCached('global')).toEqual(global);
});

test('a cache removal failure does not preserve a completed report on no-token start', async () => {
  await chrome.storage.local.set({ checkinSync: { running: false, serverCount: 100, profileTotal: 100,
    mergedThisRun: 5, outcome: 'done', complete: true } });
  await setSettings({ token: '' });
  vi.spyOn(cacheStore, 'clearAll').mockRejectedValueOnce(new Error('cache storage failed'));
  expect(await handleCheckinSyncStart()).toEqual({ type: 'checkin-sync:started', alreadyRunning: false });
  expect(localStore.get('checkinSync')).toEqual({ running: false, serverCount: 0, profileTotal: null,
    mergedThisRun: 0, outcome: 'error', complete: false });
});

test('a cache removal failure still returns and persists a no-token status reply', async () => {
  await chrome.storage.local.set({ checkinSync: { running: false, serverCount: 100, profileTotal: 100,
    mergedThisRun: 5, outcome: 'done', complete: true } });
  await setSettings({ token: '' });
  vi.spyOn(cacheStore, 'clearAll').mockRejectedValueOnce(new Error('cache storage failed'));
  expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
    serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'error', complete: false });
  expect(localStore.get('checkinSync')).toEqual({ running: false, serverCount: 0, profileTotal: null,
    mergedThisRun: 0, outcome: 'error', complete: false });
});

const scopedPersonal: MatchResult = { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
  is_drunk: true, drunk_uncertain: false, user_rating: 0, source: 'exact', searched: true, cacheBinding };

test('late cache writes from A are rejected after a same-token switch to B, including negative personal answers', async () => {
  vi.mocked(client.getCheckinSyncState).mockResolvedValue({ username: 'alice', linkRevision: 2,
    deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null });
  const negative = { ...scopedPersonal, is_drunk: false, user_rating: null };
  await handleCacheSet('late', scopedPersonal);
  await handleCacheSetMany([{ key: 'late-negative', result: negative }]);
  await cacheStore.setCached('conditional', scopedPersonal);
  expect(await handleCacheSetIfMatching('conditional', scopedPersonal, negative)).toBe(false);
  expect(await getCached('late')).toBe(null);
  expect(await getCached('late-negative')).toBe(null);
});

test('a delayed match detects backend ABA with unchanged extension credentials', async () => {
  let resolveMatch!: (results: MatchResult[]) => void;
  const post = vi.spyOn(client, 'postMatch').mockReturnValue(new Promise(resolve => { resolveMatch = resolve; }));
  const response = handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'N' }] });
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  vi.mocked(client.getCheckinSyncState).mockResolvedValue({ username: 'bob', linkRevision: 3,
    deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null });
  resolveMatch([scopedPersonal]);
  expect(await response).toEqual({ type: 'match:err', code: 'server' });
});

test('a normal sync start does not invalidate a pending match for the unchanged account', async () => {
  let resolveMatch!: (results: MatchResult[]) => void;
  const post = vi.spyOn(client, 'postMatch').mockReturnValue(new Promise(resolve => { resolveMatch = resolve; }));
  const response = handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'N' }] });
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  let feedStarted!: () => void;
  const started = new Promise<void>(resolve => { feedStarted = resolve; });
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    feedStarted();
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })));
  await handleCheckinSyncStart();
  await started;
  resolveMatch([scopedPersonal]);
  expect(await response).toEqual({ type: 'match:ok', results: [scopedPersonal] });
  await handleCheckinSyncStop();
  await vi.waitFor(async () => expect((await handleCheckinSyncStatus()).running).toBe(false));
});

test.each(['start', 'status'] as const)('retained cache entries are unreadable after failed %s cleanup and a token change', async (operation) => {
  await cacheStore.setCached('retained', scopedPersonal);
  await setSettings({ token: '' });
  vi.spyOn(cacheStore, 'clearAll').mockRejectedValueOnce(new Error('cache removal failed'));
  const operations = { start: handleCheckinSyncStart, status: handleCheckinSyncStatus };
  await operations[operation]();
  const { handleCacheGetMany } = await import('./index');
  expect(await handleCacheGetMany(['retained', 'absent'])).toEqual([null, null]);
  expect(await getCached('retained')).toEqual(scopedPersonal);
});

test('a cache batch reads only current bound entries and verifies identity around storage', async () => {
  await cacheStore.setCached('current', scopedPersonal);
  await cacheStore.setCached('legacy', { ...scopedPersonal, cacheBinding: undefined });
  await cacheStore.setCached('aba', { ...scopedPersonal, cacheBinding: { ...cacheBinding, linkRevision: 0 } });
  vi.mocked(client.getCheckinSyncState).mockClear();
  const { handleCacheGetMany } = await import('./index');
  expect(await handleCacheGetMany(['current', 'legacy', 'aba'])).toEqual([scopedPersonal, null, null]);
  expect(client.getCheckinSyncState).toHaveBeenCalledTimes(2);
});

test('a nonempty replacement token rejects old cache writes and reads', async () => {
  await cacheStore.setCached('old', scopedPersonal);
  await setSettings({ token: 'replacement-token' });
  await handleCacheSet('late', scopedPersonal);
  await handleCacheSetMany([{ key: 'late-batch', result: scopedPersonal }]);
  expect(await handleCacheSetIfMatching('old', scopedPersonal, scopedPersonal)).toBe(false);
  const { handleCacheGetMany } = await import('./index');
  expect(await handleCacheGetMany(['old', 'late', 'late-batch'])).toEqual([null, null, null]);
});

test('failed binding verification is a cache miss, and an empty scan does not probe the server', async () => {
  await cacheStore.setCached('old', scopedPersonal);
  vi.mocked(client.getCheckinSyncState).mockRejectedValue(new client.ApiError('network'));
  const { handleCacheGetMany } = await import('./index');
  expect(await handleCacheGetMany(['old'])).toEqual([null]);
  vi.mocked(client.getCheckinSyncState).mockClear();
  expect(await handleCacheGetMany([])).toEqual([]);
  expect(client.getCheckinSyncState).toHaveBeenCalledTimes(0);
});

test('current negative personal results are cached and read with their binding intact', async () => {
  const negative = { ...scopedPersonal, is_drunk: false, user_rating: null };
  await handleCacheSet('negative', negative);
  expect(await handleCacheSetIfMatching('negative', negative, scopedPersonal)).toBe(true);
  const { handleCacheGetMany } = await import('./index');
  expect(await handleCacheGetMany(['negative'])).toEqual([scopedPersonal]);
});

test('a switch while cache storage is pending makes the whole batch a miss', async () => {
  let resolveRead!: (result: MatchResult) => void;
  const read = vi.spyOn(cacheStore, 'getCached').mockReturnValue(new Promise(resolve => { resolveRead = resolve; }));
  const { handleCacheGetMany } = await import('./index');
  const response = handleCacheGetMany(['delayed']);
  await vi.waitFor(() => expect(read).toHaveBeenCalledExactlyOnceWith('delayed'));
  vi.mocked(client.getCheckinSyncState).mockResolvedValue({ username: 'alice', linkRevision: 2,
    deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null });
  resolveRead(scopedPersonal);
  expect(await response).toEqual([null]);
});

test('restoring identical credentials reuses only the unchanged account, while backend ABA rejects retained entries', async () => {
  await cacheStore.setCached('same-owner', scopedPersonal);
  await setSettings({ token: '' });
  vi.spyOn(cacheStore, 'clearAll').mockRejectedValueOnce(new Error('cache removal failed'));
  await handleCheckinSyncStatus();
  const { handleCacheGetMany } = await import('./index');
  expect(await handleCacheGetMany(['same-owner'])).toEqual([null]);
  await setSettings({ token: 'tok' });
  expect(await handleCacheGetMany(['same-owner'])).toEqual([scopedPersonal]);
  vi.mocked(client.getCheckinSyncState).mockResolvedValue({ username: 'bob', linkRevision: 3,
    deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null });
  expect(await handleCacheGetMany(['same-owner'])).toEqual([null]);
});


// #934: the scheduler's wiring in the worker. The listeners are the ones index.ts registered at import.
const onAlarm = vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0][0] as (a: { name: string }) => void;
const onStartup = vi.mocked(chrome.runtime.onStartup.addListener).mock.calls[0][0] as () => void;

describe('#934 scheduler wiring', () => {
  it('the watchdog continues an intent a dead worker left, from the first page, to the end', async () => {
    localStore.set(INTENT_KEY, { kind: 'manual', startedAt: '2026-11-01T10:00:00.000Z', silentPagesUsed: 0 });
    vi.mocked(chrome.permissions.contains).mockResolvedValue(true);
    const fetchMock = vi.fn(async (_url: string) => new Response(FEED, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({
      merged: 0, alreadyKnown: 25, pageSize: 25, nextMaxId: null, nextCursor: null, profileTotal: 100, serverCount: 12, complete: false,
    });
    onAlarm({ name: WATCHDOG_ALARM });
    await vi.waitFor(() => expect(localStore.get('checkinSync')).toMatchObject({ running: false, outcome: 'done' }));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://untappd.com/user/bob']);
    await vi.waitFor(() => expect(localStore.has(INTENT_KEY)).toBe(false));
  });

  it('a signed-out first page stops the step as no_session without sending it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><a href="/login">Log in</a></html>', { status: 200 })));
    const post = vi.spyOn(client, 'postCheckinSyncPage');
    await handleCheckinSyncStart();
    await vi.waitFor(() => expect(localStore.get('checkinSync')).toMatchObject({ running: false, outcome: 'no_session' }));
    expect(post).toHaveBeenCalledTimes(0);
  });

  it('creates the 6-hourly check alarm on browser start only when it is missing', async () => {
    vi.mocked(chrome.alarms.create).mockClear();
    vi.mocked(chrome.alarms.get).mockResolvedValueOnce(undefined);
    onStartup();
    await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledWith(CHECK_ALARM, { periodInMinutes: 360 }));

    vi.mocked(chrome.alarms.create).mockClear();
    vi.mocked(chrome.alarms.get).mockResolvedValueOnce({ name: CHECK_ALARM, scheduledTime: 0, periodInMinutes: 360 });
    onStartup();
    await new Promise((r) => setTimeout(r, 0));
    expect(chrome.alarms.create).not.toHaveBeenCalledWith(CHECK_ALARM, expect.anything());
  });

  it('a browser-start check without the untappd.com permission sends nothing', async () => {
    vi.mocked(chrome.permissions.contains).mockResolvedValue(false);
    const fetchMock = vi.fn(async () => new Response(FEED));
    vi.stubGlobal('fetch', fetchMock);
    onStartup();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(localStore.has(INTENT_KEY)).toBe(false);
  });
});
