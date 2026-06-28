import { getSettings } from '../shared/config';
import { ENRICH_ORIGINS } from '../shared/enrich-permissions';
import { postMatch, postEnrichCandidates, postEnrichResult, ApiError, getCheckinSyncState, postCheckinSyncPage } from '../api/client';
import { runCheckinSync, type SyncOutcome, type SyncProgress } from './handle-checkin-sync';
import type { AlgoliaQuery, AlgoliaResponse, EnrichCandidate, EnrichResult, MatchResult, RawBeer } from '../api/types';

export interface MatchMessage {
  type: 'match';
  cards: RawBeer[];
}

export type MatchReply =
  | { type: 'match:ok'; results: MatchResult[] }
  | { type: 'match:err'; code: 'unauthorized' | 'server' | 'network' | 'no-token' };

const MAX_PER_REQUEST = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function handleMatch(msg: MatchMessage): Promise<MatchReply> {
  const { token, baseUrl } = await getSettings();
  if (!token) return { type: 'match:err', code: 'no-token' };
  try {
    const results: MatchResult[] = [];
    for (const part of chunk(msg.cards, MAX_PER_REQUEST)) {
      results.push(...(await postMatch(baseUrl, token, part)));
    }
    return { type: 'match:ok', results };
  } catch (e) {
    const rawCode = e instanceof ApiError ? e.code : 'server';
    const code: 'unauthorized' | 'server' | 'network' =
      rawCode === 'unauthorized' || rawCode === 'network' ? rawCode : 'server';
    return { type: 'match:err', code };
  }
}

export interface EnrichFetchMessage { type: 'enrich:fetch'; algolia: AlgoliaQuery }
export interface EnrichCandidatesMessage { type: 'enrich:candidates'; beers: { brewery: string; name: string }[] }
export interface EnrichResultMessage { type: 'enrich:result'; brewery: string; name: string; algolia: AlgoliaResponse; pageUrl?: string }

async function enrichAllowed(): Promise<boolean> {
  const { enrichEnabled } = await getSettings();
  if (!enrichEnabled) return false;
  return chrome.permissions.contains({ origins: [...ENRICH_ORIGINS] });
}

export async function handleEnrichFetch(
  msg: EnrichFetchMessage,
): Promise<{ type: 'enrich:fetch:ok'; algolia: AlgoliaResponse | null }> {
  if (!(await enrichAllowed())) return { type: 'enrich:fetch:ok', algolia: null };
  try {
    const { appId, searchKey, indexName, query, hitsPerPage } = msg.algolia;
    const res = await fetch(`https://${appId}-dsn.algolia.net/1/indexes/${indexName}/query`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': appId,
        'X-Algolia-API-Key': searchKey,
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
  const { token, baseUrl, enrichEnabled } = await getSettings();
  if (!enrichEnabled || !token) return { type: 'enrich:candidates:ok', candidates: [] };
  try {
    return { type: 'enrich:candidates:ok', candidates: await postEnrichCandidates(baseUrl, token, msg.beers) };
  } catch {
    return { type: 'enrich:candidates:ok', candidates: [] };
  }
}

export async function handleEnrichResult(
  msg: EnrichResultMessage,
): Promise<{ type: 'enrich:result:ok'; result: EnrichResult | null }> {
  const { token, baseUrl, enrichEnabled } = await getSettings();
  if (!enrichEnabled || !token) return { type: 'enrich:result:ok', result: null };
  try {
    const result = await postEnrichResult(baseUrl, token, { brewery: msg.brewery, name: msg.name, algolia: msg.algolia, pageUrl: msg.pageUrl });
    return { type: 'enrich:result:ok', result };
  } catch {
    return { type: 'enrich:result:ok', result: null };
  }
}

export interface CheckinSyncStartMessage { type: 'checkin-sync:start' }
export interface CheckinSyncStatusMessage { type: 'checkin-sync:status' }

const SYNC_PAGE_CAP = 200;
const SYNC_STATE_KEY = 'checkinSync';

interface StoredSyncStatus {
  running: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
  outcome: SyncOutcome['status'] | null;
  complete: boolean;
}

async function writeSyncStatus(s: StoredSyncStatus): Promise<void> {
  await chrome.storage.session.set({ [SYNC_STATE_KEY]: s });
}

async function readSyncStatus(): Promise<StoredSyncStatus> {
  const s = await chrome.storage.session.get(SYNC_STATE_KEY);
  return (s[SYNC_STATE_KEY] as StoredSyncStatus | undefined) ?? {
    running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false,
  };
}

let syncWriteChain: Promise<void> = Promise.resolve();
function enqueueSyncStatus(s: StoredSyncStatus): Promise<void> {
  syncWriteChain = syncWriteChain.then(() => writeSyncStatus(s));
  return syncWriteChain;
}

let syncRunning = false;

// Page 1 (maxId === null) is the full profile page. Every older page is served by
// Untappd's "Show More" XHR endpoint /profile/more_feed/<user>/<offset>?v2=true (a raw
// item fragment). A `?max_id=` query on the profile page is IGNORED (always returns the
// newest page), so it must NOT be used for pagination.
export function feedUrl(username: string, maxId: string | null): string {
  const u = encodeURIComponent(username);
  return maxId === null
    ? `https://untappd.com/user/${u}`
    : `https://untappd.com/profile/more_feed/${u}/${encodeURIComponent(maxId)}?v2=true`;
}

export async function handleCheckinSyncStart(): Promise<{ type: 'checkin-sync:started'; alreadyRunning: boolean }> {
  if (syncRunning) return { type: 'checkin-sync:started', alreadyRunning: true };
  const cur = await readSyncStatus();
  if (cur.running) return { type: 'checkin-sync:started', alreadyRunning: true };

  const { token, baseUrl } = await getSettings();
  if (!token) {
    await writeSyncStatus({ ...cur, running: false, outcome: 'error' });
    return { type: 'checkin-sync:started', alreadyRunning: false };
  }

  syncRunning = true;
  await enqueueSyncStatus({ running: true, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false });

  void (async () => {
    try {
      const onProgress = (p: SyncProgress) => {
        void enqueueSyncStatus({
          running: true,
          serverCount: p.serverCount,
          profileTotal: p.profileTotal,
          mergedThisRun: p.mergedThisRun,
          outcome: null,
          complete: false,
        });
      };
      const outcome = await runCheckinSync({
        getState: () => getCheckinSyncState(baseUrl, token),
        fetchFeed: async (username, maxId) => {
          // more_feed is XHR-only: without X-Requested-With Untappd 307-redirects it to
          // /home. A redirect on that endpoint means the request wasn't honoured (e.g.
          // logged-out session) — treat it as an error rather than parsing /home (which
          // has no check-ins and would look like a clean "feed bottom").
          const isMoreFeed = maxId !== null;
          const res = await fetch(feedUrl(username, maxId), {
            credentials: 'include',
            headers: isMoreFeed ? { 'X-Requested-With': 'XMLHttpRequest' } : undefined,
          });
          if ((isMoreFeed && res.redirected) || !res.ok) {
            throw new ApiError(res.status === 403 || res.status === 429 ? 'blocked' : 'server');
          }
          return res.text();
        },
        submitPage: (html, maxId) => postCheckinSyncPage(baseUrl, token, html, maxId),
        onProgress,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        pageCap: SYNC_PAGE_CAP,
      });
      await enqueueSyncStatus({
        running: false,
        serverCount: outcome.serverCount,
        profileTotal: outcome.profileTotal,
        mergedThisRun: outcome.mergedThisRun,
        outcome: outcome.status,
        complete: outcome.complete,
      });
    } catch {
      await enqueueSyncStatus({ running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'error', complete: false });
    } finally {
      syncRunning = false;
    }
  })();

  return { type: 'checkin-sync:started', alreadyRunning: false };
}

export async function handleCheckinSyncStatus(): Promise<{ type: 'checkin-sync:status:ok' } & StoredSyncStatus> {
  return { type: 'checkin-sync:status:ok', ...(await readSyncStatus()) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const t = (message as { type?: unknown }).type;
  if (t === 'match') { handleMatch(message as MatchMessage).then(sendResponse); return true; }
  if (t === 'enrich:fetch') { handleEnrichFetch(message as EnrichFetchMessage).then(sendResponse); return true; }
  if (t === 'enrich:candidates') { handleEnrichCandidates(message as EnrichCandidatesMessage).then(sendResponse); return true; }
  if (t === 'enrich:result') { handleEnrichResult(message as EnrichResultMessage).then(sendResponse); return true; }
  if (t === 'checkin-sync:start') { handleCheckinSyncStart().then(sendResponse); return true; }
  if (t === 'checkin-sync:status') { handleCheckinSyncStatus().then(sendResponse); return true; }
  return undefined;
});
