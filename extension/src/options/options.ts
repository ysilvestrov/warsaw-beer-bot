import { getSettings, setSettings } from '../shared/config';
import { getAuthState } from '../untappd/auth';
import { countUserHad, countCatalogBeers, clearAllLocalDB } from '../db/indexed-db';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing expected element #${id}`);
  return node as T;
}

export async function refreshOptionsUI(): Promise<void> {
  const authStatusText = el<HTMLElement>('authStatusText');
  const dbStatsText = el<HTMLElement>('dbStatsText');
  const enrichCheck = el<HTMLInputElement>('enrichEnabled');

  const s = await getSettings();
  enrichCheck.checked = s.enrichEnabled;

  const auth = await getAuthState();
  if (auth.isLoggedIn && auth.user) {
    authStatusText.innerHTML = `<strong>Connected as:</strong> ${auth.user.name || auth.user.username} (@${auth.user.username})<br>Total check-ins: ${auth.user.totalCheckins}`;
    authStatusText.style.borderColor = '#4caf50';
  } else {
    authStatusText.innerHTML = '<strong>Not signed in.</strong> Open the extension popup in your browser toolbar to log in to Untappd.';
    authStatusText.style.borderColor = '#ff9800';
  }

  const hadCount = await countUserHad();
  const catCount = await countCatalogBeers();
  dbStatsText.innerHTML = `Personal tried beers stored: <strong>${hadCount}</strong><br>Cached beer catalog entries: <strong>${catCount}</strong>`;
}

export function initOptions(): void {
  const enrichCheck = el<HTMLInputElement>('enrichEnabled');
  const saveBtn = el<HTMLButtonElement>('save');
  const clearDBBtn = el<HTMLButtonElement>('clearDBBtn');
  const statusEl = el<HTMLElement>('status');

  void refreshOptionsUI();

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    await setSettings({
      enrichEnabled: enrichCheck.checked,
    });
    statusEl.textContent = '✓ Settings saved';
    saveBtn.disabled = false;
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2000);
  });

  clearDBBtn.addEventListener('click', async () => {
    clearDBBtn.disabled = true;
    await clearAllLocalDB();
    await refreshOptionsUI();
    statusEl.textContent = '✓ Local database cleared';
    clearDBBtn.disabled = false;
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2500);
  });
}

document.addEventListener('DOMContentLoaded', initOptions);
