import { pickAdapter } from '../sites/registry';
import { clearAll } from '../cache/store';

// True when the URL belongs to a supported shop, so "Refresh this page" can act.
export function canRefresh(url: string): boolean {
  try {
    return pickAdapter(new URL(url)) != null;
  } catch {
    return false;
  }
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
}

if (typeof document !== 'undefined' && document.getElementById('refresh')) {
  void initPopup();
}
