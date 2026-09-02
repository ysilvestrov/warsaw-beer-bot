import { pickAdapter } from '../sites/registry';
import { clearAll, countAll } from '../cache/store';
import { getSettings, SETUP_GUIDE_URL } from '../shared/config';
import { browserLanguages, renderSupportedShops } from './supported-shops';
import { wireClearButton } from './clear-cache';
import { applyTokenState, tokenStateView } from './token-state';

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
 * #518: the click handler gets three outcomes, not two — a transport failure
 * (`chrome.runtime.lastError`, e.g. the content script isn't injected on this page),
 * the content script itself reporting failure (`reply?.ok === false`, from
 * extension/src/content/main.ts's catch), and success. Collapsing the second into
 * the zero-cleared success text made a real failure read as "no beers on this page",
 * a factual claim about the shop that isn't true.
 */
export function refreshReplyText(reply: { ok?: boolean; cleared?: number } | undefined, lastError: boolean): string {
  if (lastError) return 'Could not reach the page — reload it and retry.';
  if (reply?.ok === false) return 'Refresh failed — reload the page and try again.';
  return refreshResultText(reply?.cleared ?? 0);
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
  const authBlock = el<HTMLElement>('authBlock');
  const getTokenBtn = el<HTMLButtonElement>('getToken');
  const guideLink = el<HTMLAnchorElement>('guideLink');
  const syncBtn = el<HTMLButtonElement>('syncCheckins');
  const syncStatus = el<HTMLElement>('syncStatus');
  const header = document.querySelector<HTMLElement>('header.head');
  const foot = document.querySelector<HTMLElement>('footer.foot');

  const { token } = await getSettings();
  const hasToken = Boolean(token);

  if (authNote && authBlock && getTokenBtn && guideLink && syncBtn && syncStatus && header && foot) {
    authNote.textContent = authNoteText(hasToken) ?? '';
    guideLink.href = SETUP_GUIDE_URL;
    getTokenBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    applyTokenState(
      { header, authBlock, syncBtn, syncStatus, getTokenBtn, guideLink, foot },
      tokenStateView(hasToken),
    );
  }

  refreshBtn.addEventListener('click', () => {
    if (tab?.id == null) return;
    refreshStatus.textContent = 'Refreshing…';
    chrome.tabs.sendMessage(tab.id, { type: 'refresh-page' }, (reply?: { ok?: boolean; cleared?: number }) => {
      refreshStatus.textContent = refreshReplyText(reply, Boolean(chrome.runtime.lastError));
    });
  });

  const clearStatus = el<HTMLElement>('clearStatus');
  if (clearStatus) wireClearButton(clearBtn, clearStatus, { count: countAll, clear: clearAll });

  if (hasToken && syncBtn && syncStatus) {
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
