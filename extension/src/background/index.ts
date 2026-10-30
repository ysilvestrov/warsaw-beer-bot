import type {
  AlgoliaQuery,
  AlgoliaResponse,
  EnrichCandidate,
  EnrichResult,
  MatchResult,
  RawBeer,
} from '../api/types';
import { clearKeys, getCached, setCached, setCachedIfMatching, setCachedMany } from '../cache/store';
import { clearAllLocalDB, countUserHad, countCatalogBeers } from '../db/indexed-db';
import { matchLocalCards } from '../untappd/matcher';
import { checkinSyncer, type LocalSyncProgress } from '../untappd/sync';

export function feedUrl(username: string, maxId: string | null): string {
  const enc = encodeURIComponent(username);
  return maxId == null
    ? `https://untappd.com/user/${enc}`
    : `https://untappd.com/profile/more_feed/${enc}/${maxId}?v2=true`;
}
import {
  getAuthState,
  saveAuthState,
  fetchUserProfileFromWeb,
  checkUntappdWebSession,
  logoutUntappd,
  type AuthState,
} from '../untappd/auth';
import { UNTAPPD_ALGOLIA_APP_ID, UNTAPPD_ALGOLIA_SEARCH_KEY } from '../untappd/search';

export interface MatchMessage {
  type: 'match';
  cards: RawBeer[];
}

export type MatchReply =
  | { type: 'match:ok'; results: MatchResult[] }
  | { type: 'match:err'; code: 'unauthorized' | 'server' | 'network' };

export async function handleMatch(msg: MatchMessage): Promise<MatchReply> {
  try {
    const results = await matchLocalCards(msg.cards);
    return { type: 'match:ok', results };
  } catch (err) {
    console.error('[beer-overlay] local match error:', err);
    return { type: 'match:err', code: 'server' };
  }
}

export interface EnrichFetchMessage {
  type: 'enrich:fetch';
  algolia: AlgoliaQuery;
}

export interface EnrichCandidatesMessage {
  type: 'enrich:candidates';
  beers: { brewery: string; name: string; abv?: number; style?: string; bid?: number }[];
}

export interface EnrichResultMessage {
  type: 'enrich:result';
  brewery: string;
  name: string;
  algolia: AlgoliaResponse;
  abv?: number;
  style?: string;
  bid?: number;
  bidSlug?: string;
  brand?: string;
  query?: string;
  pageUrl?: string;
}

export async function handleEnrichFetch(
  msg: EnrichFetchMessage,
): Promise<{ type: 'enrich:fetch:ok'; algolia: AlgoliaResponse | null }> {
  try {
    const { appId, searchKey, indexName, query, hitsPerPage } = msg.algolia;
    const res = await fetch(`https://${appId || UNTAPPD_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${indexName}/query`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': appId || UNTAPPD_ALGOLIA_APP_ID,
        'X-Algolia-API-Key': searchKey || UNTAPPD_ALGOLIA_SEARCH_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, hitsPerPage }),
    });
    if (!res.ok) return { type: 'enrich:fetch:ok', algolia: null };
    return { type: 'enrich:fetch:ok', algolia: (await res.json()) as AlgoliaResponse };
  } catch {
    return { type: 'enrich:fetch:ok', algolia: null };
  }
}

export async function handleEnrichCandidates(
  msg: EnrichCandidatesMessage,
): Promise<{ type: 'enrich:candidates:ok'; candidates: EnrichCandidate[] }> {
  // Pure in-browser candidate generation without external relay
  const candidates: EnrichCandidate[] = msg.beers.map((b) => ({
    brewery: b.brewery,
    name: b.name,
    eligible: true,
    algolia: {
      appId: UNTAPPD_ALGOLIA_APP_ID,
      searchKey: UNTAPPD_ALGOLIA_SEARCH_KEY,
      indexName: 'beer',
      query: `${b.brewery} ${b.name}`,
      hitsPerPage: 5,
    },
  }));
  return { type: 'enrich:candidates:ok', candidates };
}

export async function handleEnrichResult(
  _msg: EnrichResultMessage,
): Promise<{ type: 'enrich:result:ok'; result: EnrichResult }> {
  // In pure in-browser mode, results are already resolved locally
  return {
    type: 'enrich:result:ok',
    result: { status: 'matched' },
  };
}

// Local cache handlers for backwards compatibility with content scripts
export async function handleCacheGetMany(keys: string[]): Promise<(MatchResult | null)[]> {
  if (keys.length === 0) return [];
  return Promise.all(keys.map((k) => getCached(k)));
}

export const handleCacheSet = (key: string, result: MatchResult) => setCached(key, result);
export const handleCacheSetMany = (entries: { key: string; result: MatchResult }[]) => setCachedMany(entries);
export const handleCacheClearKeys = (keys: string[]) => clearKeys(keys);
export const handleCacheClearAll = async () => {
  await clearAllLocalDB();
  return 0;
};
export const handleCacheSetIfMatching = (key: string, expected: MatchResult, result: MatchResult) =>
  setCachedIfMatching(key, expected, result);

// Check-in Syncing Management
let latestSyncProgress: LocalSyncProgress = {
  savedCount: 0,
  totalProfileCount: null,
  newThisRun: 0,
  isComplete: false,
};

export async function handleCheckinSyncStart() {
  if (checkinSyncer.getActiveStatus()) {
    return { type: 'checkin-sync:started', alreadyRunning: true };
  }

  void checkinSyncer.startSync((progress) => {
    latestSyncProgress = progress;
  }).catch((err) => {
    console.error('[beer-overlay] Sync error:', err);
  });

  return { type: 'checkin-sync:started', alreadyRunning: false };
}

export async function handleCheckinSyncStop() {
  checkinSyncer.stopSync();
  return { type: 'checkin-sync:stopped', stopped: true };
}

export async function handleCheckinSyncStatus() {
  const isRunning = checkinSyncer.getActiveStatus();
  const dbCount = await countUserHad();
  const auth = await getAuthState();

  return {
    type: 'checkin-sync:status:ok',
    running: isRunning,
    serverCount: dbCount,
    profileTotal: auth.user?.totalBeers || latestSyncProgress.totalProfileCount,
    mergedThisRun: latestSyncProgress.newThisRun,
    outcome: latestSyncProgress.isComplete ? 'done' : null,
    complete: latestSyncProgress.isComplete,
  };
}

// Listener for runtime messages
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const t = (message as { type?: string }).type;

  // Matching
  if (t === 'match') {
    handleMatch(message as MatchMessage).then(sendResponse);
    return true;
  }

  // Enrichment
  if (t === 'enrich:fetch') {
    handleEnrichFetch(message as EnrichFetchMessage).then(sendResponse);
    return true;
  }
  if (t === 'enrich:candidates') {
    handleEnrichCandidates(message as EnrichCandidatesMessage).then(sendResponse);
    return true;
  }
  if (t === 'enrich:result') {
    handleEnrichResult(message as EnrichResultMessage).then(sendResponse);
    return true;
  }

  // Caching
  if (t === 'cache:get-many') {
    handleCacheGetMany(message.keys).then((results) => sendResponse({ results }));
    return true;
  }
  if (t === 'cache:set') {
    handleCacheSet(message.key, message.result).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  if (t === 'cache:set-many') {
    handleCacheSetMany(message.entries).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  if (t === 'cache:clear-keys') {
    handleCacheClearKeys(message.keys).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  if (t === 'cache:clear-all') {
    handleCacheClearAll().then(
      (count) => sendResponse({ ok: true, count }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }
  if (t === 'cache:set-if-matching') {
    handleCacheSetIfMatching(message.key, message.expected, message.result).then(
      (written) => sendResponse({ written }),
      () => sendResponse({ written: false }),
    );
    return true;
  }

  // Checkin Sync
  if (t === 'checkin-sync:start') {
    handleCheckinSyncStart().then(sendResponse);
    return true;
  }
  if (t === 'checkin-sync:stop') {
    handleCheckinSyncStop().then(sendResponse);
    return true;
  }
  if (t === 'checkin-sync:status') {
    handleCheckinSyncStatus().then(sendResponse);
    return true;
  }

  // Untappd Direct Auth
  if (t === 'auth:get-state') {
    getAuthState().then(async (auth) => {
      if (auth.isLoggedIn && auth.user) {
        // Refresh profile stats if older than 1 minute to ensure exact counts
        if (Date.now() - (auth.lastChecked || 0) > 60_000 || auth.user.totalBeers === 0) {
          try {
            const fresh = await fetchUserProfileFromWeb(auth.user.username);
            if (fresh.totalBeers > 0) {
              auth.user.totalBeers = fresh.totalBeers;
              auth.user.totalCheckins = fresh.totalCheckins;
              if (fresh.name) auth.user.name = fresh.name;
              if (fresh.avatar) auth.user.avatar = fresh.avatar;
              auth.lastChecked = Date.now();
              await saveAuthState(auth);
            }
          } catch {
            // Keep existing state if offline
          }
        }
      }
      const hadCount = await countUserHad();
      const catCount = await countCatalogBeers();
      sendResponse({ auth, hadCount, catCount });
    });
    return true;
  }
  if (t === 'auth:detect-web') {
    checkUntappdWebSession().then((auth) => {
      sendResponse({ auth });
    });
    return true;
  }
  if (t === 'auth:logout') {
    logoutUntappd().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  return undefined;
});
