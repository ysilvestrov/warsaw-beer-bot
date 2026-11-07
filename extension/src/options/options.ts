import { getSettings, setSettings, DEFAULT_BASE_URL, SETUP_GUIDE_URL } from '../shared/config';
import { ENRICH_ORIGINS } from '../shared/enrich-permissions';
import { getHealth, postMatch, ApiError } from '../api/client';
import { syncInstall } from '../background/install';
import { count } from '../shared/format';
export { ENRICH_ORIGINS } from '../shared/enrich-permissions';

// Replaced at build time by Vite `define`. Undefined under Vitest (no define), hence the
// typeof guard at every read. True only in the store build.
declare const __CWS_BUILD__: boolean;
const IS_STORE_BUILD = typeof __CWS_BUILD__ !== 'undefined' && __CWS_BUILD__;

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

/**
 * #923: the "Anonymous usage statistics" switch. Off marks the install for deletion before asking
 * the server, so requests stop carrying the token at once even if the server is unreachable; the
 * deletion is retried on the next start. On re-registers, once any pending deletion is done.
 */
export async function setStatisticsEnabled(on: boolean): Promise<string> {
  await setSettings(on ? { installRegistration: true } : { installRegistration: false, installDeletionPending: true });
  const state = await syncInstall().catch(() => 'none' as const);
  if (state === 'deletion_pending') return 'Deletion not finished yet — will retry.';
  return on ? 'Statistics on.' : 'Statistics off.';
}

export async function requestEnrichPermission(): Promise<boolean> {
  return chrome.permissions.request({ origins: [...ENRICH_ORIGINS] });
}

export async function removeEnrichPermission(): Promise<boolean> {
  return chrome.permissions.remove({ origins: [...ENRICH_ORIGINS] });
}

export interface LocalDbCounts {
  checkins: number;
  beers: number;
  lastSync: string | null;
}

function plural(n: number, one: string): string {
  return n === 1 ? `1 ${one}` : `${count(n)} ${one}s`;
}

function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** #924 §6: one line on what this browser keeps — counts and the local day of the last sync. */
export function localDbSummary(s: LocalDbCounts): string {
  if (s.checkins === 0) return 'Empty — open the popup and tap Sync my check-ins.';
  const counts = `${plural(s.checkins, 'check-in')} · ${plural(s.beers, 'beer')}`;
  return s.lastSync !== null ? `${counts} · last sync ${localDay(s.lastSync)}` : counts;
}

export interface LocalDbNodes {
  section: HTMLElement;
  stats: HTMLElement;
  clear: HTMLButtonElement;
  status: HTMLElement;
}

export type SendMessage = (message: { type: string }) => Promise<unknown>;

const EMPTY_COUNTS: LocalDbCounts = { checkins: 0, beers: 0, lastSync: null };

function countsOf(reply: unknown): LocalDbCounts {
  const r = reply as { type?: string; checkins?: number; beers?: number; lastSync?: string | null } | undefined;
  if (r?.type !== 'local-db:stats:ok' || typeof r.checkins !== 'number' || typeof r.beers !== 'number') return EMPTY_COUNTS;
  return { checkins: r.checkins, beers: r.beers, lastSync: r.lastSync ?? null };
}

/**
 * #924 §6: the "Local check-ins" block. Shown only without a Telegram token — with one, check-ins
 * live on the server and there is nothing in this browser to show or clear. Returns the switch the
 * page calls after Save, so the block follows a token saved or removed without a reload.
 */
export async function initLocalDb(nodes: LocalDbNodes, hasToken: boolean, send: SendMessage,
  ask: (question: string) => boolean): Promise<(hasToken: boolean) => Promise<void>> {
  let current = EMPTY_COUNTS;
  const refresh = async () => {
    current = countsOf(await send({ type: 'local-db:stats' }));
    nodes.stats.textContent = localDbSummary(current);
  };
  const show = async (token: boolean) => {
    nodes.section.hidden = token;
    nodes.status.textContent = '';
    if (!token) await refresh();
  };
  await show(hasToken);
  nodes.clear.addEventListener('click', async () => {
    const what = current.checkins > 0 ? plural(current.checkins, 'check-in') : 'the check-ins';
    if (!ask(`Delete ${what} stored in this browser? Your Untappd account is not affected.`)) return;
    nodes.clear.disabled = true;
    const reply = (await send({ type: 'local-db:clear' })) as { ok?: boolean } | undefined;
    nodes.status.textContent = reply?.ok === true ? 'Cleared.' : 'Could not clear the check-ins stored in this browser.';
    await refresh();
    nodes.clear.disabled = false;
  });
  return show;
}

function sendToWorker(message: { type: string }): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (reply?: unknown) => {
      void chrome.runtime.lastError;
      resolve(reply);
    });
  });
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

  const guideLink = el<HTMLAnchorElement>('guideLink');
  if (guideLink) guideLink.href = SETUP_GUIDE_URL;

  const s = await getSettings();
  tokenInput.value = s.token;
  urlInput.value = s.baseUrl || DEFAULT_BASE_URL;

  // Store build can't grant arbitrary hosts (no 'https://*/*'), so the custom API URL
  // is fixed to the default — hide the field and its label to avoid a dead control.
  if (IS_STORE_BUILD) {
    urlInput.style.display = 'none';
    document.querySelector('label[for="baseUrl"]')?.setAttribute('style', 'display:none');
  }

  const enrich = el<HTMLInputElement>('enrichEnabled');
  if (enrich) {
    enrich.checked = s.enrichEnabled;
    enrich.addEventListener('change', async () => {
      if (enrich.checked) {
        const granted = await requestEnrichPermission();
        enrich.checked = granted;
        await setSettings({ enrichEnabled: granted });
        status.textContent = granted ? 'Enrichment on.' : 'Permission denied.';
      } else {
        await removeEnrichPermission();
        await setSettings({ enrichEnabled: false });
        status.textContent = 'Enrichment off.';
      }
    });
  }

  const localSection = el<HTMLElement>('localDb');
  const localStats = el<HTMLElement>('localDbStats');
  const localClear = el<HTMLButtonElement>('localDbClear');
  const localStatus = el<HTMLElement>('localDbStatus');
  // A Save that comes before the block has its first counts waits for them, then applies the token
  // it saved — so a slow worker cannot leave the block on the token the page opened with.
  const localDbReady = localSection && localStats && localClear && localStatus
    ? initLocalDb({ section: localSection, stats: localStats, clear: localClear, status: localStatus },
      s.token !== '', sendToWorker, (q) => window.confirm(q))
    : Promise.resolve(null);

  const stats = el<HTMLInputElement>('installRegistration');
  const installStatus = el<HTMLElement>('installStatus');
  if (stats && installStatus) {
    stats.checked = s.installRegistration;
    if (s.installDeletionPending) installStatus.textContent = 'Deletion not finished yet — will retry.';
    stats.addEventListener('change', async () => {
      stats.disabled = true;
      installStatus.textContent = await setStatisticsEnabled(stats.checked);
      stats.disabled = false;
    });
  }

  el<HTMLButtonElement>('save')?.addEventListener('click', async () => {
    await setSettings({ token: tokenInput.value.trim(), baseUrl: urlInput.value.trim() });
    await (await localDbReady)?.(tokenInput.value.trim() !== '');
    // Best-effort: request permission for a custom (non-default) host so the worker can
    // fetch it. Skipped in the store build, which has no 'https://*/*' to grant.
    if (!IS_STORE_BUILD) {
      try {
        const origin = new URL(urlInput.value.trim()).origin + '/*';
        await chrome.permissions.request({ origins: [origin] });
      } catch {
        /* invalid URL or denied — surfaced by Test connection */
      }
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
