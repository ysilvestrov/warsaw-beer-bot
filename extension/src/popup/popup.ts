import { pickAdapter } from '../sites/registry';
import { browserLanguages, renderSupportedShops } from './supported-shops';
import type { AuthState } from '../untappd/auth';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing expected element #${id}`);
  return node as T;
}

export function canRefresh(url: string): boolean {
  try {
    return pickAdapter(new URL(url)) != null;
  } catch {
    return false;
  }
}

async function getActiveTabUrl(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.url ?? null;
  } catch {
    return null;
  }
}

async function triggerPageRefresh(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId != null) {
    await chrome.tabs.sendMessage(tabId, { type: 'refresh' });
  }
}

export function initPopup(): void {
  const userProfileBlock = el<HTMLElement>('userProfileBlock');
  const userAvatar = el<HTMLImageElement>('userAvatar');
  const userName = el<HTMLElement>('userName');
  const userStats = el<HTMLElement>('userStats');
  const dbCountEl = el<HTMLElement>('dbCount');
  const logoutBtn = el<HTMLButtonElement>('logoutBtn');

  const loginBlock = el<HTMLElement>('loginBlock');
  const detectSessionBtn = el<HTMLButtonElement>('detectSessionBtn');
  const openLoginBtn = el<HTMLButtonElement>('openLoginBtn');
  const loginError = el<HTMLElement>('loginError');

  const syncSection = el<HTMLElement>('syncSection');
  const syncBtn = el<HTMLButtonElement>('syncCheckins');
  const syncStatus = el<HTMLElement>('syncStatus');

  const refreshBtn = el<HTMLButtonElement>('refresh');
  const refreshStatus = el<HTMLElement>('refreshStatus');

  const shopCount = el<HTMLElement>('shopCount');
  const supportedShops = el<HTMLElement>('supportedShops');

  const clearAllBtn = el<HTMLButtonElement>('clearAll');
  const clearStatus = el<HTMLElement>('clearStatus');

  // Render supported shops
  const count = renderSupportedShops(supportedShops, browserLanguages(navigator));
  if (shopCount) shopCount.textContent = String(count);

  // Check refresh capability for current tab
  void getActiveTabUrl().then((url) => {
    if (!url || !canRefresh(url)) {
      refreshBtn.disabled = true;
      refreshStatus.textContent = 'Not a supported shop page';
    }
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshStatus.textContent = 'Refreshing badges…';
    try {
      await triggerPageRefresh();
      refreshStatus.textContent = '✓ Badges refreshed';
    } catch {
      refreshStatus.textContent = 'Could not refresh page';
    } finally {
      setTimeout(() => {
        refreshBtn.disabled = false;
        refreshStatus.textContent = '';
      }, 2500);
    }
  });

  // State update helper
  async function refreshState() {
    chrome.runtime.sendMessage({ type: 'auth:get-state' }, (res) => {
      if (!res) return;
      const { auth, hadCount } = res as { auth: AuthState; hadCount: number; catCount: number };
      updateUIWithAuth(auth, hadCount);
    });
  }

  function updateUIWithAuth(auth: AuthState, hadCount: number) {
    if (auth.isLoggedIn && auth.user) {
      userProfileBlock.style.display = 'block';
      loginBlock.style.display = 'none';
      syncSection.style.display = 'block';

      userName.textContent = auth.user.name || auth.user.username;
      const checkinSuffix = auth.user.totalCheckins ? ` (${auth.user.totalCheckins.toLocaleString()} check-ins)` : '';
      userStats.textContent = `@${auth.user.username} • ${auth.user.totalBeers.toLocaleString()} unique beers${checkinSuffix}`;

      if (auth.user.totalBeers > 0 && hadCount < auth.user.totalBeers) {
        dbCountEl.textContent = `${hadCount.toLocaleString()} / ${auth.user.totalBeers.toLocaleString()} beers (Sync recommended)`;
      } else if (auth.user.totalBeers > 0 && hadCount >= auth.user.totalBeers) {
        dbCountEl.textContent = `${hadCount.toLocaleString()} beers (✓ Fully synced)`;
      } else {
        dbCountEl.textContent = `${hadCount.toLocaleString()} beers`;
      }

      if (auth.user.avatar) {
        userAvatar.src = auth.user.avatar;
        userAvatar.style.display = 'block';
      } else {
        userAvatar.style.display = 'none';
      }
    } else {
      userProfileBlock.style.display = 'none';
      loginBlock.style.display = 'block';
      syncSection.style.display = 'none';
    }
  }

  // Initial state check
  void refreshState();

  // Login via web session
  detectSessionBtn.addEventListener('click', async () => {
    detectSessionBtn.disabled = true;
    detectSessionBtn.textContent = 'Checking untappd.com session…';
    loginError.style.display = 'none';

    chrome.runtime.sendMessage({ type: 'auth:detect-web' }, (res) => {
      detectSessionBtn.disabled = false;
      detectSessionBtn.textContent = 'Connect via Untappd Web Session';

      const auth = res?.auth as AuthState | undefined;
      if (auth?.isLoggedIn) {
        void refreshState();
      } else {
        loginError.textContent = auth?.error || 'Active untappd.com session not found. Please click "Open untappd.com to sign in" first.';
        loginError.style.display = 'block';
      }
    });
  });

  // Open official untappd login in a new browser tab
  openLoginBtn.addEventListener('click', () => {
    void chrome.tabs.create({ url: 'https://untappd.com/login' });
  });

  // Logout
  logoutBtn.addEventListener('click', () => {
    logoutBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'auth:logout' }, () => {
      logoutBtn.disabled = false;
      void refreshState();
    });
  });

  // Checkin Sync polling
  let syncPollTimer: NodeJS.Timeout | null = null;

  function pollSyncStatus() {
    chrome.runtime.sendMessage({ type: 'checkin-sync:status' }, (res) => {
      if (!res) return;
      const { running, serverCount, profileTotal, complete } = res;

      if (running) {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing…';
        syncStatus.textContent = profileTotal
          ? `Syncing… ${serverCount.toLocaleString()} / ${profileTotal.toLocaleString()}`
          : `Syncing… ${serverCount.toLocaleString()}`;
      } else {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync my check-ins';
        if (syncPollTimer) {
          clearInterval(syncPollTimer);
          syncPollTimer = null;
        }
        if (complete) {
          syncStatus.textContent = `✓ Fully synced (${serverCount.toLocaleString()} beers in local DB)`;
        }
        void refreshState();
      }
    });
  }

  syncBtn.addEventListener('click', () => {
    syncBtn.disabled = true;
    syncStatus.textContent = 'Starting sync…';

    chrome.runtime.sendMessage({ type: 'checkin-sync:start' }, () => {
      if (syncPollTimer) clearInterval(syncPollTimer);
      syncPollTimer = setInterval(pollSyncStatus, 1500);
      pollSyncStatus();
    });
  });

  // Clear local DB cache
  clearAllBtn.addEventListener('click', () => {
    clearAllBtn.disabled = true;
    clearStatus.textContent = 'Clearing…';

    chrome.runtime.sendMessage({ type: 'cache:clear-all' }, () => {
      clearStatus.textContent = '✓ Local database cleared';
      clearAllBtn.disabled = false;
      setTimeout(() => {
        clearStatus.textContent = '';
      }, 2500);
      void refreshState();
    });
  });
}

document.addEventListener('DOMContentLoaded', initPopup);
