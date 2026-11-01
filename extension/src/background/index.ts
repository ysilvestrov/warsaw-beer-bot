import { authToken, getSettings, wantsRegistration, type Settings } from '../shared/config';
import { ENRICH_ORIGINS } from '../shared/enrich-permissions';
import { postMatch, postEnrichCandidates, postEnrichResult, ApiError, DEFAULT_TIMEOUT_MS, getCheckinSyncState, postCheckinSyncPage, type MatchClient } from '../api/client';
import { ensureInstall, extensionVersion, forgetInstallToken } from './install';
import { feedFailure, runCheckinSync, type SyncOutcome, type SyncProgress } from './handle-checkin-sync';
import {
  CHECK_ALARM, CHECK_PERIOD_MINUTES, INTENT_KEY, WATCHDOG_ALARM, createSyncScheduler,
  type SchedulerReport, type StepRequest,
} from './sync-scheduler';
import { sessionUsername } from '../../../src/shared/untappd/session-user';
import type { AlgoliaQuery, AlgoliaResponse, EnrichCandidate, EnrichResult, MatchResult, MatchCacheBinding, RawBeer, CheckinSyncState } from '../api/types';
import { clearAll, clearKeys, getCached, setCached, setCachedIfMatching, setCachedMany } from '../cache/store';

export interface MatchMessage {
  type: 'match';
  cards: RawBeer[];
}

export type MatchReply =
  | { type: 'match:ok'; results: MatchResult[] }
  | { type: 'match:err'; code: 'unauthorized' | 'server' | 'network' };

let cacheMutationChain: Promise<unknown> = Promise.resolve();

function enqueueCacheMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = cacheMutationChain.then(work, work);
  cacheMutationChain = result.then(() => undefined, () => undefined);
  return result;
}

async function currentCacheBinding(): Promise<MatchCacheBinding> {
  const { token, baseUrl } = await getSettings();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([baseUrl, token])));
  const credential = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  let username = '';
  let linkRevision = 0;
  if (token) {
    try {
      const state = await getCheckinSyncState(baseUrl, token);
      if (!Number.isSafeInteger(state.linkRevision) || state.linkRevision < 0) throw new ApiError('server');
      username = state.username.toLowerCase();
      linkRevision = state.linkRevision;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'not_linked') throw error;
    }
  }
  const latest = await getSettings();
  if (latest.token !== token || latest.baseUrl !== baseUrl) throw new ApiError('unauthorized');
  return { username, linkRevision, credential };
}

function sameCacheBinding(a: MatchCacheBinding | undefined, b: MatchCacheBinding): boolean {
  return a?.username === b.username && a.linkRevision === b.linkRevision && a.credential === b.credential;
}

export async function handleCacheGetMany(keys: string[]): Promise<(MatchResult | null)[]> {
  if (keys.length === 0) return [];
  try {
    const binding = await currentCacheBinding();
    const results = await Promise.all(keys.map(key => getCached(key)));
    if (!sameCacheBinding(binding, await currentCacheBinding())) return keys.map(() => null);
    return results.map(result => result && sameCacheBinding(result.cacheBinding, binding) ? result : null);
  } catch {
    return keys.map(() => null);
  }
}

export const handleCacheSet = (key: string, result: MatchResult) =>
  enqueueCacheMutation(async () => {
    if (sameCacheBinding(result.cacheBinding, await currentCacheBinding())) await setCached(key, result);
  });
export const handleCacheSetMany = (entries: { key: string; result: MatchResult }[]) =>
  enqueueCacheMutation(async () => {
    const binding = await currentCacheBinding();
    await setCachedMany(entries.filter(entry => sameCacheBinding(entry.result.cacheBinding, binding)));
  });
export const handleCacheClearKeys = (keys: string[]) =>
  enqueueCacheMutation(async () => { await clearKeys(keys); });
export const handleCacheClearAll = () => enqueueCacheMutation(() => clearAll());
export const handleCacheSetIfMatching = (key: string, expected: MatchResult, result: MatchResult) =>
  enqueueCacheMutation(async () => {
    const binding = await currentCacheBinding();
    if (!sameCacheBinding(expected.cacheBinding, binding) || !sameCacheBinding(result.cacheBinding, binding)) return false;
    return setCachedIfMatching(key, expected, result);
  });

// #923: the shop the cards came from, for per-shop accounting. The server caps it at 64 characters
// and rejects the whole request beyond that, so a longer hostname is simply not sent.
export function shopOf(senderUrl: string | undefined): string | undefined {
  try {
    const host = new URL(senderUrl ?? '').hostname;
    return host && host.length <= 64 ? host : undefined;
  } catch {
    return undefined;
  }
}

// A 401 on the install token means the server forgot it (pruned or deleted). The cards are
// re-asked anonymously — the install token's answer is the anonymous answer anyway.
async function postMatchAs(settings: Settings, cards: RawBeer[], client: MatchClient): Promise<MatchResult[]> {
  const bearer = authToken(settings);
  try {
    return await postMatch(settings.baseUrl, bearer, cards, DEFAULT_TIMEOUT_MS, client);
  } catch (e) {
    if (settings.token || !bearer || !(e instanceof ApiError) || e.code !== 'unauthorized') throw e;
    await forgetInstallToken(bearer);
    return postMatch(settings.baseUrl, '', cards, DEFAULT_TIMEOUT_MS, client);
  }
}

export async function handleMatch(msg: MatchMessage, shop?: string): Promise<MatchReply> {
  try {
    const binding = await currentCacheBinding();
    const settings = await getSettings();
    const client: MatchClient = { version: extensionVersion(), ...(shop !== undefined ? { shop } : {}) };
    const results = await postMatchAs(settings, msg.cards, client);
    const current = await currentCacheBinding();
    if (!sameCacheBinding(binding, current)) throw new ApiError(binding.credential !== current.credential ? 'unauthorized' : 'server');
    return { type: 'match:ok', results: results.map(result => ({ ...result, cacheBinding: binding })) };
  } catch (e) {
    const rawCode = e instanceof ApiError ? e.code : 'server';
    const code: 'unauthorized' | 'server' | 'network' =
      rawCode === 'unauthorized' || rawCode === 'network' ? rawCode : 'server';
    return { type: 'match:err', code };
  }
}

export interface EnrichFetchMessage { type: 'enrich:fetch'; algolia: AlgoliaQuery }
// #369: abv/style are optional shop-published facts. Absent fields are omitted,
// never sent as null, and an abv of 0 is a real value.
// #384: `bid` (+ the slug/brand the server's guard verifies it against) is the Untappd
// identity the shop publishes on its own product page. Absent for shops that publish none.
export interface EnrichCandidatesMessage { type: 'enrich:candidates'; beers: { brewery: string; name: string; abv?: number; style?: string; bid?: number }[] }
export interface EnrichResultMessage { type: 'enrich:result'; brewery: string; name: string; algolia: AlgoliaResponse; abv?: number; style?: string; bid?: number; bidSlug?: string; brand?: string; query?: string; pageUrl?: string }

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
  let settings = await getSettings();
  // The first page after install can ask before registration has answered; without waiting, its
  // missing beers would settle unsearched. Only waits when a registration is actually due.
  if (settings.enrichEnabled && wantsRegistration(settings)) {
    await ensureInstall();
    settings = await getSettings();
  }
  const token = authToken(settings);
  if (!settings.enrichEnabled || !token) return { type: 'enrich:candidates:ok', candidates: [] };
  try {
    return { type: 'enrich:candidates:ok', candidates: await postEnrichCandidates(settings.baseUrl, token, msg.beers) };
  } catch (e) {
    await forgetRejectedInstall(settings, token, e);
    return { type: 'enrich:candidates:ok', candidates: [] };
  }
}

// #923: enrich has no anonymous form, so a 401 on the install token only forgets it.
async function forgetRejectedInstall(settings: Settings, bearer: string, e: unknown): Promise<void> {
  if (!settings.token && e instanceof ApiError && e.code === 'unauthorized') await forgetInstallToken(bearer);
}

export async function handleEnrichResult(
  msg: EnrichResultMessage,
): Promise<{ type: 'enrich:result:ok'; result: EnrichResult | null }> {
  const settings = await getSettings();
  const token = authToken(settings);
  if (!settings.enrichEnabled || !token) return { type: 'enrich:result:ok', result: null };
  try {
    const result = await postEnrichResult(settings.baseUrl, token, {
      brewery: msg.brewery, name: msg.name, algolia: msg.algolia,
      ...(msg.abv !== undefined ? { abv: msg.abv } : {}),
      ...(msg.style !== undefined ? { style: msg.style } : {}),
      ...(msg.bid !== undefined ? { bid: msg.bid } : {}),
      ...(msg.bidSlug !== undefined ? { bidSlug: msg.bidSlug } : {}),
      ...(msg.brand !== undefined ? { brand: msg.brand } : {}),
      ...(msg.query !== undefined ? { query: msg.query } : {}),
      pageUrl: msg.pageUrl,
    });
    return { type: 'enrich:result:ok', result };
  } catch (e) {
    await forgetRejectedInstall(settings, token, e);
    return { type: 'enrich:result:ok', result: null };
  }
}

export interface CheckinSyncStartMessage { type: 'checkin-sync:start' }
export interface CheckinSyncStatusMessage { type: 'checkin-sync:status' }
export interface CheckinSyncStopMessage { type: 'checkin-sync:stop' }

const SYNC_STATE_KEY = 'checkinSync';
const UNTAPPD_ORIGINS = ['https://untappd.com/*'];

interface SyncBinding {
  username: string;
  linkRevision: number;
  token: string;
  baseUrl: string;
}

interface StoredSyncStatus {
  binding?: SyncBinding | null;
  running: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
  outcome: SyncOutcome['status'] | null;
  complete: boolean;
  // #934: what the scheduler adds once an intent is settled. Absent in older records.
  caughtUp?: boolean;
  gapMissing?: number;
  pausedUntil?: string;
  quiet?: boolean;
}

// #934: chrome.storage.local, not session — after a browser restart the popup still knows how
// the last sync ended, and the scheduler's intent lives next to it.
async function writeSyncStatus(s: StoredSyncStatus): Promise<void> {
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: s });
}

async function readSyncStatus(): Promise<StoredSyncStatus> {
  const s = await chrome.storage.local.get(SYNC_STATE_KEY);
  return (s[SYNC_STATE_KEY] as StoredSyncStatus | undefined) ?? {
    running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false,
  };
}

let syncGeneration = 0;
let syncWriteChain: Promise<void> = Promise.resolve();
function enqueueSyncStatus(s: StoredSyncStatus, generation = syncGeneration): Promise<void> {
  return enqueueSyncStatusPatch(() => s, generation);
}
function enqueueSyncStatusPatch(next: (cur: StoredSyncStatus) => StoredSyncStatus | null, generation = syncGeneration): Promise<void> {
  syncWriteChain = syncWriteChain.catch(() => undefined).then(async () => {
    if (generation !== syncGeneration) return;
    const s = next(await readSyncStatus());
    if (s) {
      await writeSyncStatus(s);
      await applySyncBadge(s);
    }
  });
  return syncWriteChain;
}

// #934 §5: the badge follows the stored status — '!' while a silent check left more new check-ins
// than its budget pulls in. Derived, so a worker start restores it from the same record.
const BADGE_COLOR = '#b45309';
async function applySyncBadge(s: StoredSyncStatus): Promise<void> {
  const text = s.outcome === 'gap' && !s.running ? '!' : '';
  try {
    if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text });
  } catch (error) {
    // The badge is display only: a failed call must not fail the status write.
    console.warn('[beer-overlay] sync badge update failed', error);
  }
}

export async function restoreSyncBadge(): Promise<void> {
  await applySyncBadge(await readSyncStatus());
}

let syncRunning = false;
let syncAbortController: AbortController | null = null;
type CheckinSyncStartReply = { type: 'checkin-sync:started'; alreadyRunning: boolean };
let syncStartPromise: Promise<CheckinSyncStartReply> | null = null;
// #934: a manual start replies once its step has written the first status, as before the scheduler.
let pendingStartAck: { resolve: (r: CheckinSyncStartReply) => void; reject: (e: unknown) => void } | null = null;
// The generation of the step a report is about: the report must not outlive an invalidation.
// null — no step ran for this intent in this worker (resume dropped it): the current generation.
let reportGeneration: number | null = null;

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

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

const syncScheduler = createSyncScheduler({
  store: {
    get: async <T,>(key: string) => (await chrome.storage.local.get(key))[key] as T | undefined,
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
    remove: (key) => chrome.storage.local.remove(key),
  },
  alarms: {
    create: async (name, periodInMinutes) => { await chrome.alarms.create(name, { periodInMinutes }); },
    clear: async (name) => { await chrome.alarms.clear(name); },
  },
  now: () => new Date(),
  runStep: runSyncStep,
  clearMatchCache: async () => { await handleCacheClearAll(); },
  hasUntappdPermission: () => chrome.permissions.contains({ origins: UNTAPPD_ORIGINS }),
  hasToken: async () => Boolean((await getSettings()).token),
  onReport: reportSyncIntent,
});

// #934: the scheduler's verdict on top of the step's own terminal status — only what the step could
// not know (gap instead of capped, the pause, a quiet hint), and a terminal write the step lost.
async function reportSyncIntent(r: SchedulerReport): Promise<void> {
  const o = r.outcome;
  // A report without a step in this worker is about the current state, not an older step's.
  const generation = r.afterStep ? reportGeneration ?? syncGeneration : syncGeneration;
  reportGeneration = null;
  await enqueueSyncStatusPatch((cur) => {
    const next: StoredSyncStatus = { ...cur };
    let changed = false;
    if (cur.running || cur.outcome !== o.status) {
      Object.assign(next, { running: false, outcome: o.status, serverCount: o.serverCount, profileTotal: o.profileTotal,
        mergedThisRun: o.mergedThisRun, complete: o.complete });
      // A replaced outcome takes nothing of the old record's verdict along (no ✓ on not_linked).
      delete next.caughtUp; delete next.gapMissing; delete next.pausedUntil; delete next.quiet;
      changed = true;
    }
    if (o.caughtUp) { next.caughtUp = true; changed = true; }
    if (r.gapMissing !== null) { next.gapMissing = r.gapMissing; changed = true; }
    if (r.pausedUntil !== null) { next.pausedUntil = r.pausedUntil; changed = true; }
    if (r.quiet) { next.quiet = true; changed = true; }
    return changed ? next : null;
  }, generation).catch(() => undefined);
}

export async function handleCheckinSyncStart(): Promise<CheckinSyncStartReply> {
  if (syncStartPromise) {
    try {
      await syncStartPromise;
      return { type: 'checkin-sync:started', alreadyRunning: true };
    } catch {
      return { type: 'checkin-sync:started', alreadyRunning: false };
    }
  }
  if (syncRunning) {
    // #934: a silent step is in flight — the press turns it into a manual intent, so the budget no
    // longer stops it. The step goes on; no second run starts.
    await syncScheduler.startManual().catch(() => undefined);
    return { type: 'checkin-sync:started', alreadyRunning: true };
  }
  const startPromise = startManualSync();
  syncStartPromise = startPromise;
  try {
    return await startPromise;
  } catch {
    return { type: 'checkin-sync:started', alreadyRunning: false };
  } finally {
    if (syncStartPromise === startPromise) syncStartPromise = null;
  }
}

async function startManualSync(): Promise<CheckinSyncStartReply> {
  const ack = new Promise<CheckinSyncStartReply>((resolve, reject) => { pendingStartAck = { resolve, reject }; });
  try {
    const { alreadyRunning } = await syncScheduler.startManual();
    if (alreadyRunning) {
      // Between two steps of a running intent: the next step picks the manual intent up.
      pendingStartAck = null;
      return { type: 'checkin-sync:started', alreadyRunning: true };
    }
  } catch (error) {
    pendingStartAck = null;
    throw error;
  }
  // The loop this start joined may already be past its step: its end answers the press then.
  const settled = syncScheduler.idle().then((): CheckinSyncStartReply => ({ type: 'checkin-sync:started', alreadyRunning: true }));
  try {
    return await Promise.race([ack, settled]);
  } finally {
    pendingStartAck = null;
  }
}

// #934: one step of the scheduler — the #611 run as it was: status, binding, cache invalidation.
async function runSyncStep(step: StepRequest): Promise<SyncOutcome> {
  const ack = pendingStartAck;
  pendingStartAck = null;
  let launched: { reply: CheckinSyncStartReply; done: Promise<SyncOutcome> };
  try {
    launched = await launchCheckinSync(step);
  } catch (error) {
    ack?.reject(error);
    throw error;
  }
  ack?.resolve(launched.reply);
  return launched.done;
}

async function launchCheckinSync(step: StepRequest): Promise<{ reply: CheckinSyncStartReply; done: Promise<SyncOutcome> }> {
  const reply: CheckinSyncStartReply = { type: 'checkin-sync:started', alreadyRunning: false };
  const cur = await readSyncStatus();

  const { token, baseUrl } = await getSettings();
  if (!token) {
    const generation = ++syncGeneration;
    reportGeneration = generation;
    try {
      await handleCacheClearAll();
    } catch (error) {
      // Physical cleanup may fail. Every production read still validates the
      // credential/account binding, so retained entries cannot cross accounts.
      console.warn('[beer-overlay] cache cleanup failed; stale bindings remain unreadable', error);
    }
    await enqueueSyncStatus(emptySyncStatus('error'), generation);
    return { reply, done: Promise.resolve({ status: 'error', complete: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, caughtUp: false }) };
  }

  const generation = ++syncGeneration;
  reportGeneration = generation;
  let binding: SyncBinding | null = null;
  syncRunning = true;
  const controller = new AbortController();
  syncAbortController = controller;
  if (step.signal.aborted) controller.abort();
  else step.signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    await enqueueSyncStatus({ running: true, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false, binding }, generation);
  } catch (error) {
    syncRunning = false;
    syncAbortController = null;
    throw error;
  }

  const done = (async (): Promise<SyncOutcome> => {
    let terminalStatus: StoredSyncStatus | null = null;
    let outcome: SyncOutcome = { status: 'error', complete: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, caughtUp: false };
    try {
      const onProgress = (p: SyncProgress) => {
        void enqueueSyncStatus({
          binding,
          running: true,
          serverCount: p.serverCount,
          profileTotal: p.profileTotal,
          mergedThisRun: p.mergedThisRun,
          outcome: null,
          complete: false,
        }, generation).catch(() => undefined);
      };
      outcome = await runCheckinSync({
        getState: async () => {
          const state = await getCheckinSyncState(baseUrl, token);
          if (generation !== syncGeneration) controller.abort();
          if (Number.isSafeInteger(state.linkRevision) && state.linkRevision >= 0) {
            binding = { username: state.username.toLowerCase(), linkRevision: state.linkRevision, token, baseUrl };
            if (!cur.binding || cur.binding.username !== binding.username
              || cur.binding.linkRevision !== binding.linkRevision || cur.binding.token !== token || cur.binding.baseUrl !== baseUrl) {
              await handleCacheClearAll();
            }
            await enqueueSyncStatus({ binding, running: true, serverCount: state.serverCount,
              profileTotal: state.profileTotal, mergedThisRun: 0, outcome: null, complete: false }, generation);
          }
          return state;
        },
        fetchFeed: async (username, maxId) => {
          // more_feed is XHR-only: without X-Requested-With Untappd 307-redirects it to
          // /home. A redirect on that endpoint means the request wasn't honoured — treat it as
          // an error rather than parsing /home. A signed-out more_feed answers an empty 200
          // (probe 2026-10-31, #934): the session is checked on the first page instead.
          const isMoreFeed = maxId !== null;
          const res = await fetch(feedUrl(username, maxId), {
            credentials: 'include',
            headers: isMoreFeed ? { 'X-Requested-With': 'XMLHttpRequest' } : undefined,
            signal: controller.signal,
          });
          const failure = feedFailure(isMoreFeed, res);
          if (failure === 'feed_unavailable') {
            // #846: єдине місце, де цей факт узагалі існує — сервер цього запиту не бачить.
            console.warn('[beer-overlay] Untappd did not return the check-in feed', { status: res.status, redirected: res.redirected, deep: isMoreFeed });
          }
          if (failure) throw new ApiError(failure);
          return res.text();
        },
        submitPage: (html, maxId, linkRevision) => postCheckinSyncPage(baseUrl, token, html, maxId, controller.signal, undefined, linkRevision),
        onProgress,
        sleep: (ms) => abortableDelay(ms, controller.signal),
        pageCap: step.pageCap,
        signal: controller.signal,
        sessionOf: sessionUsername,
        beforeFetch: step.beforeFetch,
        afterPage: step.afterPage,
      });
      terminalStatus = {
        binding,
        running: false,
        serverCount: outcome.serverCount,
        profileTotal: outcome.profileTotal,
        mergedThisRun: outcome.mergedThisRun,
        outcome: outcome.status,
        complete: outcome.complete,
      };
      await enqueueSyncStatus(terminalStatus, generation);
    } catch {
      if (terminalStatus) {
        await enqueueSyncStatus(terminalStatus, generation).catch(() => undefined);
      } else {
        await enqueueSyncStatus({ running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'error', complete: false, binding }, generation).catch(() => undefined);
      }
    } finally {
      syncRunning = false;
      if (syncAbortController === controller) syncAbortController = null;
    }
    return outcome;
  })();

  return { reply, done };
}

export async function handleCheckinSyncStop(): Promise<{ type: 'checkin-sync:stopped'; stopped: boolean }> {
  // #934: the intent goes first, so the scheduler does not start another step after the abort.
  await syncScheduler.stop().catch(() => false);
  if (syncAbortController) {
    syncAbortController.abort();
    return { type: 'checkin-sync:stopped', stopped: true };
  }

  const cur = await readSyncStatus();
  if (!cur.running) return { type: 'checkin-sync:stopped', stopped: false };
  await enqueueSyncStatus({ ...cur, running: false, outcome: 'cancelled' });
  return { type: 'checkin-sync:stopped', stopped: true };
}

function emptySyncStatus(outcome: StoredSyncStatus['outcome'] = null, state?: CheckinSyncState): StoredSyncStatus {
  return { running: false, serverCount: state?.serverCount ?? 0, profileTotal: state?.profileTotal ?? null,
    mergedThisRun: 0, outcome, complete: false };
}

// Credentials are worker-only; never return the private binding in a popup/content reply — only the
// linked username, for "Sign in as <username>".
// #934: a stored intent reads as running — between two steps the record briefly says `capped`,
// which the person must not see as a finished sync.
function syncStatusReply(s: StoredSyncStatus, intentStored = false) {
  return { type: 'checkin-sync:status:ok' as const, running: s.running || intentStored, serverCount: s.serverCount,
    profileTotal: s.profileTotal, mergedThisRun: s.mergedThisRun, outcome: s.outcome, complete: s.complete,
    caughtUp: s.caughtUp === true, gapMissing: s.gapMissing ?? null, pausedUntil: s.pausedUntil ?? null,
    quiet: s.quiet === true, username: s.binding?.username ?? null };
}

async function hasSyncIntent(): Promise<boolean> {
  return (await chrome.storage.local.get(INTENT_KEY))[INTENT_KEY] !== undefined;
}

export async function handleCheckinSyncStatus() {
  const generation = syncGeneration;
  const settings = await getSettings();
  if (!settings.token) {
    if (generation !== syncGeneration) return syncStatusReply(emptySyncStatus());
    const invalidationGeneration = ++syncGeneration;
    syncAbortController?.abort();
    try {
      await handleCacheClearAll();
    } catch (error) {
      // Physical cleanup may fail. Every production read still validates the
      // credential/account binding, so retained entries cannot cross accounts.
      console.warn('[beer-overlay] cache cleanup failed; stale bindings remain unreadable', error);
    }
    await enqueueSyncStatus(emptySyncStatus('error'), invalidationGeneration).catch(() => undefined);
    return syncStatusReply(emptySyncStatus('error'));
  }
  let current: CheckinSyncState;
  try {
    current = await getCheckinSyncState(settings.baseUrl, settings.token);
  } catch (error) {
    return syncStatusReply(emptySyncStatus(error instanceof ApiError && error.code === 'not_linked' ? 'not_linked' : 'error'));
  }
  if (!Number.isSafeInteger(current.linkRevision) || current.linkRevision < 0) {
    return syncStatusReply(emptySyncStatus('sync_context_required'));
  }
  const latestSettings = await getSettings();
  const orphaned = !syncStartPromise && !syncRunning && !syncAbortController && !syncScheduler.running;
  const status = await readSyncStatus();
  if (generation !== syncGeneration || latestSettings.token !== settings.token || latestSettings.baseUrl !== settings.baseUrl) {
    return syncStatusReply(emptySyncStatus());
  }
  if (!status.binding && (syncStartPromise || syncRunning)) {
    return syncStatusReply({ ...emptySyncStatus(null, current), running: true });
  }
  const binding = status.binding;
  const matches = binding && binding.username === current.username.toLowerCase()
    && binding.linkRevision === current.linkRevision && binding.token === settings.token && binding.baseUrl === settings.baseUrl;
  if (!matches) {
    const invalidationGeneration = ++syncGeneration;
    syncAbortController?.abort();
    await handleCacheClearAll();
    const fresh = { ...emptySyncStatus(binding ? 'account_changed' : null, current),
      binding: { username: current.username.toLowerCase(), linkRevision: current.linkRevision, token: settings.token, baseUrl: settings.baseUrl } };
    await enqueueSyncStatus(fresh, invalidationGeneration).catch(() => undefined);
    return syncStatusReply(invalidationGeneration === syncGeneration ? fresh : emptySyncStatus());
  }
  const intentStored = await hasSyncIntent();
  // #934: a running status with a stored intent is not an orphan — the watchdog continues it.
  if (status.running && orphaned && !intentStored) {
    const recovered = { ...status, running: false, outcome: 'error' as const, complete: false };
    await enqueueSyncStatus(recovered, generation).catch(() => undefined);
    return syncStatusReply(recovered);
  }
  return syncStatusReply(status, intentStored);
}

// #934: the check alarm keeps its period across worker restarts — created only when missing.
async function ensureCheckAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(CHECK_ALARM))) await chrome.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => { void ensureInstall(); void ensureCheckAlarm(); });
chrome.runtime.onStartup.addListener(() => {
  void ensureInstall();
  void ensureCheckAlarm();
  void syncScheduler.check();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) void syncScheduler.resume();
  if (alarm.name === CHECK_ALARM) void syncScheduler.check();
});
// Every worker start: an intent a dead worker left behind continues from the first page.
void syncScheduler.resume();
// Chrome keeps no badge text across browser starts: the stored status brings it back.
void restoreSyncBadge();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void ensureInstall();
  const t = (message as { type?: unknown }).type;
  if (t === 'match') { handleMatch(message as MatchMessage, shopOf(sender.tab?.url)).then(sendResponse); return true; }
  if (t === 'enrich:fetch') { handleEnrichFetch(message as EnrichFetchMessage).then(sendResponse); return true; }
  if (t === 'enrich:candidates') { handleEnrichCandidates(message as EnrichCandidatesMessage).then(sendResponse); return true; }
  if (t === 'enrich:result') { handleEnrichResult(message as EnrichResultMessage).then(sendResponse); return true; }
  if (t === 'cache:get-many') { handleCacheGetMany(message.keys).then(results => sendResponse({ results })); return true; }
  if (t === 'cache:set') { handleCacheSet(message.key, message.result).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false })); return true; }
  if (t === 'cache:set-many') { handleCacheSetMany(message.entries).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false })); return true; }
  if (t === 'cache:clear-keys') { handleCacheClearKeys(message.keys).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false })); return true; }
  if (t === 'cache:clear-all') { handleCacheClearAll().then((count) => sendResponse({ ok: true, count }), () => sendResponse({ ok: false })); return true; }
  if (t === 'cache:set-if-matching') {
    handleCacheSetIfMatching(message.key, message.expected, message.result).then((written) => sendResponse({ written }), () => sendResponse({ written: false })); return true;
  }
  if (t === 'checkin-sync:start') { handleCheckinSyncStart().then(sendResponse); return true; }
  if (t === 'checkin-sync:stop') { handleCheckinSyncStop().then(sendResponse); return true; }
  if (t === 'checkin-sync:status') { handleCheckinSyncStatus().then(sendResponse); return true; }
  return undefined;
});
