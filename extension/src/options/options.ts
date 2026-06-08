import { getSettings, setSettings, DEFAULT_BASE_URL } from '../shared/config';
import { getHealth, postMatch, ApiError } from '../api/client';

export interface ConnectionResult {
  ok: boolean;
  reason?: 'health' | ApiError['code'];
}

export async function testConnection(baseUrl: string, token: string): Promise<ConnectionResult> {
  const healthy = await getHealth(baseUrl);
  if (!healthy) return { ok: false, reason: 'health' };
  try {
    await postMatch(baseUrl, token, [{ brewery: 'connection', name: 'check' }]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof ApiError ? e.code : 'server' };
  }
}

// --- DOM wiring (runs only in the options page, not under test) ---
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function initOptionsPage(): Promise<void> {
  const tokenInput = el<HTMLInputElement>('token');
  const urlInput = el<HTMLInputElement>('baseUrl');
  const status = el<HTMLElement>('status');
  if (!tokenInput || !urlInput || !status) return;

  const s = await getSettings();
  tokenInput.value = s.token;
  urlInput.value = s.baseUrl || DEFAULT_BASE_URL;

  el<HTMLButtonElement>('save')?.addEventListener('click', async () => {
    await setSettings({ token: tokenInput.value.trim(), baseUrl: urlInput.value.trim() });
    // Best-effort: request permission for a custom (non-default) host so the worker can fetch it.
    try {
      const origin = new URL(urlInput.value.trim()).origin + '/*';
      await chrome.permissions.request({ origins: [origin] });
    } catch {
      /* invalid URL or denied — surfaced by Test connection */
    }
    status.textContent = 'Saved.';
  });

  el<HTMLButtonElement>('test')?.addEventListener('click', async () => {
    status.textContent = 'Testing…';
    const r = await testConnection(urlInput.value.trim(), tokenInput.value.trim());
    status.textContent = r.ok ? '✅ Connected.' : `❌ Failed (${r.reason}).`;
  });
}

if (typeof document !== 'undefined' && document.getElementById('token')) {
  void initOptionsPage();
}
