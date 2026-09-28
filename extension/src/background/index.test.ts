import * as cacheStore from '../cache/store';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  feedUrl, handleCacheSet, handleCacheSetMany, handleCacheSetIfMatching,
  handleCheckinSyncStart, handleCheckinSyncStatus, handleCheckinSyncStop, handleMatch,
} from './index';
import { setSettings } from '../shared/config';
import { getCached } from '../cache/store';
import type { MatchResult } from '../api/types';
import * as client from '../api/client';

const sessionStore = new Map<string, unknown>();

beforeEach(async () => {
  sessionStore.clear();
  Object.assign(chrome.storage, {
    session: {
      get: vi.fn(async (key: string) => sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) sessionStore.set(key, value);
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
    is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
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

    await expect(handleMatch({ type: 'match', cards })).resolves.toEqual({ type: 'match:ok', results: [orphan] });
    expect(client.postMatch).toHaveBeenCalledTimes(1);
    expect(client.postMatch).toHaveBeenCalledWith('https://api.test', 'tok', cards);
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
        return Promise.resolve(new Response('<html>feed</html>', { status: 200 }));
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
    await chrome.storage.session.set({
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
    await chrome.storage.session.set({
      checkinSync: {
        running: true, serverCount: 12, profileTotal: 100, mergedThisRun: 4, outcome: null, complete: false,
        binding: { username: 'bob', linkRevision: 1, token: 'tok', baseUrl: 'https://api.test' },
      },
    });
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<Record<string, unknown>>((resolve) => {
      releaseFirstRead = () => resolve({});
    });
    vi.mocked(chrome.storage.session.get).mockImplementationOnce(async () => firstRead);
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>feed</html>', { status: 200 })));
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
    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(new Error('session storage unavailable'));
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>feed</html>', { status: 200 })));
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
    vi.mocked(chrome.storage.session.set).mockImplementation(async (values: Record<string, unknown>) => {
      const status = values.checkinSync as { outcome?: unknown } | undefined;
      if (status?.outcome === 'done' && !rejectedDoneWrite) {
        rejectedDoneWrite = true;
        throw new Error('session storage unavailable');
      }
      for (const [key, value] of Object.entries(values)) sessionStore.set(key, value);
    });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>feed</html>', { status: 200 })));
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
    const writtenOutcomes = vi.mocked(chrome.storage.session.set).mock.calls.map(([values]) =>
      ((values as Record<string, unknown>).checkinSync as { outcome?: unknown } | undefined)?.outcome);
    expect(writtenOutcomes).not.toContain('error');
  });

  it('recovers a stale running status when terminal status writes keep failing', async () => {
    let rejectedDoneWrites = 0;
    vi.mocked(chrome.storage.session.set).mockImplementation(async (values: Record<string, unknown>) => {
      const status = values.checkinSync as { outcome?: unknown } | undefined;
      if (status?.outcome === 'done' && rejectedDoneWrites < 2) {
        rejectedDoneWrites++;
        throw new Error('session storage unavailable');
      }
      for (const [key, value] of Object.entries(values)) sessionStore.set(key, value);
    });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({
      username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 12, profileTotal: 100,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>feed</html>', { status: 200 })));
    vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({
      merged: 1, alreadyKnown: 24, pageSize: 25, nextMaxId: null, nextCursor: null,
      profileTotal: 100, serverCount: 13, complete: true,
    });

    await handleCheckinSyncStart();

    await vi.waitFor(() => expect(rejectedDoneWrites).toBe(2));
    await vi.waitFor(async () => {
      expect(await handleCheckinSyncStatus()).toMatchObject({ running: false, outcome: 'error' });
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
    const fetchMock = vi.fn(async () => new Response('<html>feed</html>', { status: 200 }));
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
    await chrome.storage.session.set({ checkinSync: completed });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ ...current, deepest_max_id: null, serverCount: 0, profileTotal: null, complete: false });
    await handleCacheSet('old-personal', { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
      is_drunk: true, drunk_uncertain: false, user_rating: 4, source: 'exact', searched: true });
    expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
      serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'account_changed', complete: false });
    expect(await getCached('old-personal')).toBe(null);
  });
  it('retains a verified report without exposing credentials in the popup reply', async () => {
    await chrome.storage.session.set({ checkinSync: completed });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'BOB', linkRevision: 1, deepest_max_id: null, serverCount: 100, profileTotal: null, complete: false });
    expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
      serverCount: 100, profileTotal: 100, mergedThisRun: 5, outcome: 'done', complete: true });
  });
  it('cannot establish a cached completion when current state is unavailable', async () => {
    await chrome.storage.session.set({ checkinSync: completed });
    vi.spyOn(client, 'getCheckinSyncState').mockRejectedValue(new Error('offline'));
    expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
      serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'error', complete: false });
  });
  it('discards an old report without a binding', async () => {
    const { binding: _binding, ...legacy } = completed;
    await chrome.storage.session.set({ checkinSync: legacy });
    vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'bob', linkRevision: 1, deepest_max_id: null, serverCount: 12, profileTotal: null, complete: false });
    expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
      serverCount: 12, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false });
  });
  it('does not reuse a report after credentials change, even with the same username and revision', async () => {
    await chrome.storage.session.set({ checkinSync: completed });
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
  vi.stubGlobal('fetch', async () => new Response('feed'));
  let releasePage!: (s: never) => void;
  const page = new Promise<never>(resolve => { releasePage = resolve; });
  const submit = vi.spyOn(client, 'postCheckinSyncPage').mockImplementationOnce(() => page);
  await handleCheckinSyncStart();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const reading = handleCheckinSyncStatus();
  await vi.waitFor(() => expect(client.getCheckinSyncState).toHaveBeenCalledTimes(2));
  releasePage({ merged: 1, alreadyKnown: 0, pageSize: 1, nextMaxId: null, nextCursor: null,
    profileTotal: 13, serverCount: 13, complete: false } as never);
  await vi.waitFor(() => expect(sessionStore.get('checkinSync')).toMatchObject({ outcome: 'done' }));
  releaseValidation(state);
  expect(await reading).toEqual({ type: 'checkin-sync:status:ok', running: false,
    serverCount: 13, profileTotal: 13, mergedThisRun: 1, outcome: 'done', complete: true });
});

test('queued progress and a terminal reply from A cannot restore A after a verified switch to B', async () => {
  const a = { username: 'bob', linkRevision: 1, deepest_max_id: null, complete: false, serverCount: 99, profileTotal: 100 };
  const b = { username: 'other', linkRevision: 2, deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null };
  vi.spyOn(client, 'getCheckinSyncState').mockResolvedValueOnce(a).mockResolvedValue(b);
  vi.stubGlobal('fetch', async () => new Response('feed'));
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
  expect(sessionStore.get('checkinSync')).toMatchObject({ binding: { username: 'other', linkRevision: 2 }, serverCount: 0, complete: false });
});


test('starting B directly clears cached A personal matches before reporting B progress', async () => {
  await chrome.storage.session.set({ checkinSync: { running: false, serverCount: 100, profileTotal: 100,
    mergedThisRun: 5, outcome: 'done', complete: true,
    binding: { username: 'bob', linkRevision: 1, token: 'tok', baseUrl: 'https://api.test' } } });
  await handleCacheSet('old-personal', { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
    is_drunk: true, drunk_uncertain: false, user_rating: 4, source: 'exact', searched: true });
  vi.spyOn(client, 'getCheckinSyncState').mockResolvedValue({ username: 'other', linkRevision: 2,
    deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null });
  vi.stubGlobal('fetch', async () => new Response('<html></html>'));
  vi.spyOn(client, 'postCheckinSyncPage').mockResolvedValue({ merged: 0, alreadyKnown: 0, pageSize: 0,
    nextMaxId: null, nextCursor: null, profileTotal: null, serverCount: 0, complete: false });
  await handleCheckinSyncStart();
  await vi.waitFor(() => expect(sessionStore.get('checkinSync')).toMatchObject({ running: false, outcome: 'done' }));
  expect(await getCached('old-personal')).toBe(null);
});

test('a start without credentials cannot retain an earlier completion', async () => {
  await chrome.storage.session.set({ checkinSync: { running: false, serverCount: 100, profileTotal: 100,
    mergedThisRun: 5, outcome: 'done', complete: true,
    binding: { username: 'bob', linkRevision: 1, token: 'tok', baseUrl: 'https://api.test' } } });
  await handleCacheSet('old-personal', { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
    is_drunk: true, drunk_uncertain: false, user_rating: 4, source: 'exact', searched: true });
  await setSettings({ token: '' });
  await handleCheckinSyncStart();
  expect(await getCached('old-personal')).toBe(null);
  expect(sessionStore.get('checkinSync')).toEqual({ running: false, serverCount: 0, profileTotal: null,
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
    is_drunk: true, drunk_uncertain: false, user_rating: 4, source: 'exact', searched: true });
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
  expect(sessionStore.get('checkinSync')).toEqual({ running: false, serverCount: 0, profileTotal: null,
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
    is_drunk: true, drunk_uncertain: false, user_rating: 0, source: 'exact', searched: true }]);
  expect(await response).toEqual({ type: 'match:err', code: 'unauthorized' });
});

test('late personal cache writes cannot repopulate cleared credentials, while global matches still cache', async () => {
  const personal: MatchResult = { raw: { brewery: 'B', name: 'N' }, matched_beer: null,
    is_drunk: true, drunk_uncertain: false, user_rating: 0, source: 'exact', searched: true };
  const global: MatchResult = { ...personal, is_drunk: false, user_rating: null };
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
  await chrome.storage.session.set({ checkinSync: { running: false, serverCount: 100, profileTotal: 100,
    mergedThisRun: 5, outcome: 'done', complete: true } });
  await setSettings({ token: '' });
  vi.spyOn(cacheStore, 'clearAll').mockRejectedValueOnce(new Error('cache storage failed'));
  expect(await handleCheckinSyncStart()).toEqual({ type: 'checkin-sync:started', alreadyRunning: false });
  expect(sessionStore.get('checkinSync')).toEqual({ running: false, serverCount: 0, profileTotal: null,
    mergedThisRun: 0, outcome: 'error', complete: false });
});

test('a cache removal failure still returns and persists a no-token status reply', async () => {
  await chrome.storage.session.set({ checkinSync: { running: false, serverCount: 100, profileTotal: 100,
    mergedThisRun: 5, outcome: 'done', complete: true } });
  await setSettings({ token: '' });
  vi.spyOn(cacheStore, 'clearAll').mockRejectedValueOnce(new Error('cache storage failed'));
  expect(await handleCheckinSyncStatus()).toEqual({ type: 'checkin-sync:status:ok', running: false,
    serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'error', complete: false });
  expect(sessionStore.get('checkinSync')).toEqual({ running: false, serverCount: 0, profileTotal: null,
    mergedThisRun: 0, outcome: 'error', complete: false });
});
