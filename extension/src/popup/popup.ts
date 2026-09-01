import { pickAdapter } from '../sites/registry';
import { clearAll, countAll } from '../cache/store';
import { getSettings, SETUP_GUIDE_URL } from '../shared/config';
import { browserLanguages, renderSupportedShops } from './supported-shops';
import { wireClearButton } from './clear-cache';

export interface SyncStatusView {
  running: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
  outcome: 'done' | 'capped' | 'cancelled' | 'not_linked' | 'blocked' | 'error' | null;
  complete: boolean;
}

export function formatSyncStatus(s: SyncStatusView): string {
  if (s.running) {
    return s.profileTotal !== null
      ? `Syncing… ${s.serverCount} / ${s.profileTotal}`
      : `Syncing… ${s.serverCount}`;
  }
  switch (s.outcome) {
    case 'not_linked': return 'Link your Untappd account in the bot first (/link).';
    case 'blocked': return 'Untappd is rate-limiting — try again later.';
    case 'error': return 'Sync failed — check your connection and token, then retry.';
    case 'capped': return `Synced ${s.serverCount}${s.profileTotal !== null ? ` of ${s.profileTotal}` : ''}.`;
    case 'cancelled': return `Sync stopped at ${s.serverCount}${s.profileTotal !== null ? ` of ${s.profileTotal}` : ''}.`;
    case 'done':
      return s.complete
        ? `✓ Fully synced (${s.serverCount}).`
        : `Synced ${s.serverCount}${s.profileTotal !== null ? ` of ${s.profileTotal}` : ''}.`;
    default: return '';
  }
}

export function syncButtonLabel(s: SyncStatusView): string {
  if (s.running) return 'Stop';
  if (s.outcome === 'capped') {
    return s.profileTotal === null
      ? 'Continue sync'
      : `Continue — ${Math.max(0, s.profileTotal - s.serverCount)} left`;
  }
  return 'Sync my check-ins';
}

type SendSyncStart = (callback: () => void) => void;

export async function requestSyncStart(sendStart: SendSyncStart, timeoutMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const acknowledged = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      try {
        sendStart(() => finish(true));
      } catch {
        finish(false);
      }
    });
    if (acknowledged) return true;
  }
  return false;
}

// True when the URL belongs to a supported shop, so "Refresh this page" can act.
export function canRefresh(url: string): boolean {
  try {
    return pickAdapter(new URL(url)) != null;
  } catch {
    return false;
  }
}

/** Popup note shown when the extension has no token: global-only, with how to authorize. */
export function authNoteText(hasToken: boolean): string | null {
  return hasToken
    ? null
    : "Not connected — showing global ratings only (⭐). Add a token to see which beers you've had ✅ and your own rating.";
}

/** The setup-guide link is shown in the same no-token state as the auth note. */
export function guideLinkVisible(hasToken: boolean): boolean {
  return !hasToken;
}

/** Pluralizes a count of beers (parsed cards) — the refresh result's noun, distinct from clear-cache.ts's cache-entry `entries()`. */
export function beers(n: number): string {
  return n === 1 ? '1 beer' : `${n} beers`;
}

// #524: "Refreshed (0 cleared)." is true and reads as failure. `cleared` is the
// number of cache keys `refreshCards` pushed — one per parsed card on the page
// (extension/src/content/refresh.ts) — so 0 means the adapter found no beer cards
// on this page, NOT that the cache was already warm; a page full of already-cached
// beers reports the card count, never zero.
export function refreshResultText(cleared: number): string {
  return cleared === 0
    ? 'Nothing to refresh — no beers found on this page.'
    : `Refreshed — ${beers(cleared)} will be rechecked.`;
}

/**
 * #524: attaches aria-live AFTER init has written the initial text, so opening the
 * popup announces nothing and every later change — always a response to a click —
 * is announced once, beside the control that caused it.
 */
export function armLiveRegions(nodes: Array<HTMLElement | null>): void {
  for (const node of nodes) node?.setAttribute('aria-live', 'polite');
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function initPopup(): Promise<void> {
  const refreshBtn = el<HTMLButtonElement>('refresh');
  const clearBtn = el<HTMLButtonElement>('clearAll');
  const refreshStatus = el<HTMLElement>('refreshStatus');
  if (!refreshBtn || !clearBtn || !refreshStatus) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  refreshBtn.disabled = !canRefresh(url);
  if (refreshBtn.disabled) refreshStatus.textContent = 'Open a supported shop page to refresh it.';

  const shopList = el<HTMLElement>('supportedShops');
  if (shopList) {
    const languages = browserLanguages(navigator);
    const shopCount = renderSupportedShops(shopList, languages);
    const countLabel = el<HTMLElement>('shopCount');
    if (countLabel) countLabel.textContent = String(shopCount);
  }

  const authNote = el<HTMLElement>('authNote');
  const getTokenBtn = el<HTMLButtonElement>('getToken');
  const guideLink = el<HTMLAnchorElement>('guideLink');
  const { token } = await getSettings();
  const note = authNoteText(Boolean(token));
  if (authNote && getTokenBtn && guideLink) {
    if (note) {
      authNote.textContent = note;
      authNote.style.display = '';
      getTokenBtn.style.display = '';
      getTokenBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
      guideLink.href = SETUP_GUIDE_URL;
      guideLink.style.display = guideLinkVisible(Boolean(token)) ? '' : 'none';
    } else {
      authNote.style.display = 'none';
      getTokenBtn.style.display = 'none';
      guideLink.style.display = 'none';
    }
  }

  refreshBtn.addEventListener('click', () => {
    if (tab?.id == null) return;
    refreshStatus.textContent = 'Refreshing…';
    chrome.tabs.sendMessage(tab.id, { type: 'refresh-page' }, (reply?: { cleared?: number }) => {
      refreshStatus.textContent = chrome.runtime.lastError
        ? 'Could not reach the page — reload it and retry.'
        : refreshResultText(reply?.cleared ?? 0);
    });
  });

  const clearStatus = el<HTMLElement>('clearStatus');
  if (clearStatus) wireClearButton(clearBtn, clearStatus, { count: countAll, clear: clearAll });

  const syncBtn = el<HTMLButtonElement>('syncCheckins');
  const syncStatus = el<HTMLElement>('syncStatus');
  if (syncBtn && syncStatus) {
    const syncLabel = syncBtn.querySelector('span');
    let latestSyncStatus: SyncStatusView | null = null;
    const render = (s: SyncStatusView) => {
      latestSyncStatus = s;
      syncStatus.textContent = formatSyncStatus(s);
      syncBtn.disabled = false;
      if (syncLabel) syncLabel.textContent = syncButtonLabel(s);
    };
    const poll = () => {
      chrome.runtime.sendMessage({ type: 'checkin-sync:status' }, (s?: SyncStatusView) => {
        if (chrome.runtime.lastError || !s) {
          latestSyncStatus = null;
          syncStatus.textContent = 'Sync interrupted — tap Sync to resume.';
          syncBtn.disabled = false;
          if (syncLabel) syncLabel.textContent = 'Sync my check-ins';
          return;
        }
        render(s);
        if (s.running) setTimeout(poll, 1500);
      });
    };
    syncBtn.addEventListener('click', async () => {
      if (latestSyncStatus?.running) {
        syncBtn.disabled = true;
        syncStatus.textContent = 'Stopping…';
        chrome.runtime.sendMessage({ type: 'checkin-sync:stop' }, () => { void chrome.runtime.lastError; });
        return;
      }
      syncBtn.disabled = true;
      syncStatus.textContent = 'Starting…';
      // Fetching the user's feed needs the untappd.com host permission (optional,
      // shared with enrichment). Request it in this user-gesture context so a user
      // who never enabled enrichment can still sync. Must be the first await so the
      // gesture isn't consumed.
      const granted = await chrome.permissions.request({ origins: ['https://untappd.com/*'] });
      if (!granted) {
        syncStatus.textContent = 'Allow access to untappd.com to sync your check-ins.';
        syncBtn.disabled = false;
        return;
      }
      await requestSyncStart((callback) => {
        chrome.runtime.sendMessage({ type: 'checkin-sync:start' }, () => {
          void chrome.runtime.lastError;
          callback();
        });
      }, 1500);
      poll();
    });
    poll(); // reflect an in-progress run when the popup (re)opens
  }

  armLiveRegions([el<HTMLElement>('syncStatus'), refreshStatus, el<HTMLElement>('clearStatus')]);
}

if (typeof document !== 'undefined' && document.getElementById('refresh')) {
  void initPopup();
}
