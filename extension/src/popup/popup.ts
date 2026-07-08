import { pickAdapter } from '../sites/registry';
import { clearAll } from '../cache/store';
import { getSettings } from '../shared/config';

export interface SyncStatusView {
  running: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
  outcome: 'done' | 'capped' | 'not_linked' | 'blocked' | 'error' | null;
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
    case 'capped': return `Synced ${s.serverCount} of ${s.profileTotal ?? '?'} — tap Sync again to continue.`;
    case 'done':
      return s.complete
        ? `✓ Fully synced (${s.serverCount}).`
        : `Synced ${s.serverCount}${s.profileTotal !== null ? ` of ${s.profileTotal}` : ''}.`;
    default: return '';
  }
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
    : 'Не авторизовано — показуються лише глобальні рейтинги (⭐). Додай токен, щоб бачити «вже пив» ✅ і свою оцінку.';
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function initPopup(): Promise<void> {
  const refreshBtn = el<HTMLButtonElement>('refresh');
  const clearBtn = el<HTMLButtonElement>('clearAll');
  const status = el<HTMLElement>('status');
  if (!refreshBtn || !clearBtn || !status) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  refreshBtn.disabled = !canRefresh(url);
  if (refreshBtn.disabled) status.textContent = 'Open a supported shop page to refresh it.';

  const authNote = el<HTMLElement>('authNote');
  const getTokenBtn = el<HTMLButtonElement>('getToken');
  const { token } = await getSettings();
  const note = authNoteText(Boolean(token));
  if (authNote && getTokenBtn) {
    if (note) {
      authNote.textContent = note;
      authNote.style.display = '';
      getTokenBtn.style.display = '';
      getTokenBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    } else {
      authNote.style.display = 'none';
      getTokenBtn.style.display = 'none';
    }
  }

  refreshBtn.addEventListener('click', () => {
    if (tab?.id == null) return;
    status.textContent = 'Refreshing…';
    chrome.tabs.sendMessage(tab.id, { type: 'refresh-page' }, (reply?: { cleared?: number }) => {
      status.textContent = chrome.runtime.lastError
        ? 'Could not reach the page — reload it and retry.'
        : `Refreshed (${reply?.cleared ?? 0} cleared).`;
    });
  });

  clearBtn.addEventListener('click', async () => {
    await clearAll();
    status.textContent = 'Cache cleared.';
  });

  const syncBtn = el<HTMLButtonElement>('syncCheckins');
  const syncStatus = el<HTMLElement>('syncStatus');
  if (syncBtn && syncStatus) {
    const render = (s: SyncStatusView) => {
      syncStatus.textContent = formatSyncStatus(s);
      syncBtn.disabled = s.running;
    };
    const poll = () => {
      chrome.runtime.sendMessage({ type: 'checkin-sync:status' }, (s?: SyncStatusView) => {
        if (chrome.runtime.lastError || !s) {
          syncStatus.textContent = 'Sync interrupted — tap Sync to resume.';
          syncBtn.disabled = false;
          return;
        }
        render(s);
        if (s.running) setTimeout(poll, 1500);
      });
    };
    syncBtn.addEventListener('click', async () => {
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
      chrome.runtime.sendMessage({ type: 'checkin-sync:start' }, () => poll());
    });
    poll(); // reflect an in-progress run when the popup (re)opens
  }
}

if (typeof document !== 'undefined' && document.getElementById('refresh')) {
  void initPopup();
}
