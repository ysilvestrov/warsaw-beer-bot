import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  feedUrl,
  handleCacheSet,
  handleCacheSetMany,
  handleCacheSetIfMatching,
  handleCacheClearAll,
  handleCheckinSyncStart,
  handleCheckinSyncStatus,
  handleCheckinSyncStop,
  handleMatch,
} from './index';
import { getCached } from '../cache/store';
import type { MatchResult } from '../api/types';
import * as matcher from '../untappd/matcher';
import { checkinSyncer } from '../untappd/sync';
import * as db from '../db/indexed-db';

const sessionStore = new Map<string, unknown>();

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  sessionStore.clear();
  Object.assign(chrome.storage, {
    session: {
      get: vi.fn(async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {})),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) sessionStore.set(key, value);
      }),
    },
  });
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
    is_drunk: false,
    drunk_uncertain: false,
    user_rating: null,
    source: 'exact',
    searched: true,
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

  it('clears all local cache and database', async () => {
    vi.spyOn(db, 'clearAllLocalDB').mockResolvedValue();
    const result = await handleCacheClearAll();
    expect(result).toBe(0);
    expect(db.clearAllLocalDB).toHaveBeenCalled();
  });
});

describe('handleMatch', () => {
  it('invokes local matcher and returns ok', async () => {
    const matched: MatchResult = {
      raw: { brewery: 'B', name: '0' },
      matched_beer: { id: 1, brewery: 'B', name: '0', rating_global: 4.0, untappd_id: 10 },
      is_drunk: true,
      drunk_uncertain: false,
      user_rating: 4.5,
      source: 'exact',
      searched: true,
    };
    vi.spyOn(matcher, 'matchLocalCards').mockResolvedValue([matched]);

    const res = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: '0' }] });
    expect(res).toEqual({ type: 'match:ok', results: [matched] });
  });
});

describe('check-in sync controls', () => {
  it('starts sync when not currently running', async () => {
    vi.spyOn(checkinSyncer, 'getActiveStatus').mockReturnValue(false);
    vi.spyOn(checkinSyncer, 'startSync').mockResolvedValue({
      savedCount: 50,
      totalProfileCount: 100,
      newThisRun: 50,
      isComplete: false,
    });

    const res = await handleCheckinSyncStart();
    expect(res).toEqual({ type: 'checkin-sync:started', alreadyRunning: false });
  });

  it('reports already running if active', async () => {
    vi.spyOn(checkinSyncer, 'getActiveStatus').mockReturnValue(true);

    const res = await handleCheckinSyncStart();
    expect(res).toEqual({ type: 'checkin-sync:started', alreadyRunning: true });
  });

  it('stops running sync', async () => {
    const stopSpy = vi.spyOn(checkinSyncer, 'stopSync').mockImplementation(() => {});

    const res = await handleCheckinSyncStop();
    expect(res).toEqual({ type: 'checkin-sync:stopped', stopped: true });
    expect(stopSpy).toHaveBeenCalled();
  });

  it('reports sync status from local db and syncer', async () => {
    vi.spyOn(checkinSyncer, 'getActiveStatus').mockReturnValue(false);
    vi.spyOn(db, 'countUserHad').mockResolvedValue(150);

    const status = await handleCheckinSyncStatus();
    expect(status.running).toBe(false);
    expect(status.serverCount).toBe(150);
  });
});
