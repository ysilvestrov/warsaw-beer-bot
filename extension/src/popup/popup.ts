import { pickAdapter } from '../sites/registry';
import { countAll } from '../cache/store';
import { clearAll } from '../cache/client';
import { authToken, getSettings, SETUP_GUIDE_URL, syncMode } from '../shared/config';
import { count } from '../shared/format';
import { browserLanguages, renderSupportedShops } from './supported-shops';
import { wireClearButton } from './clear-cache';
import { applyTokenState, tokenStateView } from './token-state';
import type { SyncOutcome } from '../background/handle-checkin-sync';

export interface SyncStatusView {
  running: boolean;
  serverCount: number;
  profileTotal: number | null;
  mergedThisRun: number;
  // #587: похідне від фонового типу, а не власна копія — інакше новий статус
  // фону (напр. `no_session`) мовчки провалюється в `default` без помилки типів.
  outcome: SyncOutcome['status'] | null;
  complete: boolean;
  // #934: the scheduler's verdict. «✓ Fully synced» rests on `caughtUp` alone, never on the counts.
  caughtUp: boolean;
  gapMissing: number | null;
  pausedUntil: string | null;
  quiet: boolean;
  username: string | null;
  /** #924: the popup's own mode (from the token), not the worker's reply. Absent — linked. */
  mode?: 'linked' | 'local';
}

/** #924: the same question Options asks before the same deletion. */
export const CLEAR_QUESTION = 'Delete the check-ins stored in this browser? Your Untappd account is not affected.';

export const UNTAPPD_HOME = 'https://untappd.com/';

export interface SyncWidgetView {
  label: string;
  /** null — no bar; 'unknown' — an empty bar with the count only (profile total unknown). */
  bar: number | 'unknown' | null;
  detail: string | null;
  /** 'clear' — #924: empty the local check-ins, then sync (another account in local mode). */
  action: { kind: 'start' | 'stop' | 'clear'; label: string } | null;
  link: { text: string; href: string } | null;
  tone: 'neutral' | 'error';
}

export { count };

/** #934 §6: an honest percentage of the counts — a display, no decision rests on it. */
export function syncPercent(serverCount: number, profileTotal: number | null): number | null {
  if (profileTotal === null || profileTotal <= 0) return null;
  return Math.min(100, Math.floor((serverCount / profileTotal) * 100));
}

function checkins(n: number): string {
  return n === 1 ? '1 check-in' : `${count(n)} check-ins`;
}

/** #934 §6: one label, one bar, one action per sync state. */
export function syncWidgetView(s: SyncStatusView, now: Date): SyncWidgetView {
  const p = syncPercent(s.serverCount, s.profileTotal);
  const bar = p ?? 'unknown';
  const ofTotal = s.profileTotal !== null ? `${count(s.serverCount)} of ${count(s.profileTotal)}` : count(s.serverCount);
  const view = (label: string, rest: Partial<SyncWidgetView> = {}): SyncWidgetView =>
    ({ label, bar: null, detail: null, action: null, link: null, tone: 'neutral', ...rest });
  const start = (label: string) => ({ kind: 'start' as const, label });
  const untappd = { text: 'Open untappd.com', href: UNTAPPD_HOME };

  if (s.running) {
    return view(p !== null ? `Syncing… ${p}\u202f%` : 'Syncing…', {
      bar, detail: s.profileTotal !== null ? ofTotal : checkins(s.serverCount), action: { kind: 'stop', label: 'Stop' },
    });
  }
  switch (s.outcome) {
    case null: return view('', { action: start('Sync my check-ins') });
    case 'done':
    // A record without an intent that says `capped`: a silent check spent on a hole, or an older version's.
    case 'capped':
      return s.outcome === 'done' && s.caughtUp
        ? view('✓ Fully synced', { bar: 100, detail: checkins(s.serverCount) })
        : view(`Synced ${ofTotal}`, { bar, action: start('Sync again') });
    case 'gap':
      return view(s.gapMissing !== null ? `${s.gapMissing === 1 ? '1 new check-in' : `${count(s.gapMissing)} new check-ins`}` : 'New check-ins',
        { bar, action: start('Sync') });
    case 'no_session':
      return s.quiet
        ? view('Sign in to untappd.com to keep ✅ fresh', { link: untappd })
        : view('Paused: sign in to untappd.com', { bar, link: untappd, action: start('Sync') });
    case 'blocked':
      return view('Paused: Untappd is limiting requests', {
        bar,
        detail: s.pausedUntil !== null && Date.parse(s.pausedUntil) > now.getTime() ? 'Resumes tomorrow' : null,
        action: start('Try now'),
      });
    // Two causes land here: the browser is signed in to another account, or the bot was re-linked
    // (the worker then stores account_changed until the next sync). The label fits both, and Sync
    // stays — after signing in, the person must not wait for the next quiet check.
    case 'account_changed':
      // #924: in local mode the database belongs to one account; the person decides whether to drop it.
      // Signing back in as the owner is the other way out, hence the link; Clear asks before deleting.
      if (s.mode === 'local') {
        return view('Untappd account changed', {
          detail: s.username !== null
            ? `This browser's check-ins belong to ${s.username}. Sign in as ${s.username}, or clear them and sync this account.`
            : 'Sign in to the account these check-ins belong to, or clear them and sync this account.',
          link: untappd, action: { kind: 'clear', label: 'Clear and sync' },
        });
      }
      return view('Untappd account changed', {
        detail: s.username !== null ? `Sign in as ${s.username}, then Sync` : 'Sign in to the linked account, then Sync',
        link: untappd, action: start('Sync'),
      });
    case 'not_linked': return view('Link Untappd in the bot', { detail: 'Send /link to the bot' });
    case 'sync_context_required': return view('Update the extension');
    case 'feed_unavailable':
      return view('Untappd did not return your feed', { bar, tone: 'error', action: start('Retry') });
    // Не «nothing was saved»: сторінки, прийняті до відмови, уже збережені.
    case 'page_rejected':
      return view('Untappd sent an unexpected page', {
        bar, tone: 'error', detail: 'Try again later, or use /import in the bot', action: start('Retry'),
      });
    case 'error': return view('Sync failed', { bar, tone: 'error', action: start('Retry') });
    case 'cancelled':
      return view(p !== null ? `Stopped at ${p}\u202f%` : `Stopped at ${count(s.serverCount)}`, { bar, action: start('Sync') });
    default: {
      // #587: вичерпний switch — якщо `SyncOutcome['status']` отримає новий варіант
      // без гілки тут, компілятор впаде на цьому присвоєнні, а не мовчки поверне порожній стан.
      const exhaustive: never = s.outcome;
      return exhaustive;
    }
  }
}

interface SyncWidgetNodes {
  label: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  detail: HTMLElement;
  link: HTMLAnchorElement;
  button: HTMLButtonElement;
  buttonLabel: HTMLElement | null;
}

/** The only code that writes a SyncWidgetView into the DOM. */
export function renderSyncWidget(n: SyncWidgetNodes, v: SyncWidgetView): void {
  n.label.textContent = v.label;
  n.label.classList.toggle('is-error', v.tone === 'error');
  n.bar.hidden = v.bar === null;
  if (typeof v.bar === 'number') {
    n.bar.setAttribute('aria-valuenow', String(v.bar));
    n.fill.style.width = `${v.bar}%`;
  } else {
    n.bar.removeAttribute('aria-valuenow');
    n.fill.style.width = '0';
  }
  n.detail.textContent = v.detail ?? '';
  n.link.hidden = v.link === null;
  n.link.textContent = v.link?.text ?? '';
  n.link.href = v.link?.href ?? UNTAPPD_HOME;
  n.button.hidden = v.action === null;
  n.button.disabled = false;
  if (n.buttonLabel && v.action) n.buttonLabel.textContent = v.action.label;
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

/** Popup note shown when the extension has no Telegram token: what local mode gives, and what a token adds. */
export function authNoteText(hasToken: boolean, hasInstall = false): string | null {
  if (hasToken) return null;
  return hasInstall
    ? 'Works without Telegram — ⭐ global ratings, missing-beer search, and ✅ from check-ins you sync into this browser only. A bot token adds recommendations and sync across devices.'
    : 'Works without Telegram — ⭐ global ratings and ✅ from check-ins you sync into this browser only. A bot token adds recommendations and sync across devices.';
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

  const settings = await getSettings();
  const hasToken = Boolean(settings.token);
  const hasInstall = Boolean(authToken(settings)) && !hasToken;

  if (authNote && authBlock && getTokenBtn && guideLink && syncBtn && syncStatus && header && foot) {
    authNote.textContent = authNoteText(hasToken, hasInstall) ?? '';
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

  const widget = el<HTMLElement>('syncWidget');
  const widgetNodes = syncBtn && widget ? {
    label: el<HTMLElement>('syncLabel'), bar: el<HTMLElement>('syncBar'), fill: el<HTMLElement>('syncBarFill'),
    detail: el<HTMLElement>('syncDetail'), link: el<HTMLAnchorElement>('syncLink'), button: syncBtn,
    buttonLabel: syncBtn.querySelector<HTMLElement>('span'),
  } : null;
  // #924: both modes sync — to the server with a Telegram token, into this browser without one.
  const mode = syncMode(settings);
  if (syncBtn && syncStatus && widget && widgetNodes?.label && widgetNodes.bar && widgetNodes.fill
    && widgetNodes.detail && widgetNodes.link) {
    const nodes = widgetNodes as SyncWidgetNodes;
    widget.hidden = false;
    let latestView: SyncWidgetView | null = null;
    const render = (s: SyncStatusView) => {
      latestView = syncWidgetView({ ...s, mode }, new Date());
      // The popup's own messages (Starting…, Stopping…) give way to the state they were about.
      syncStatus.textContent = '';
      renderSyncWidget(nodes, latestView);
    };
    const poll = () => {
      chrome.runtime.sendMessage({ type: 'checkin-sync:status' }, (s?: SyncStatusView) => {
        if (chrome.runtime.lastError || !s) {
          latestView = null;
          renderSyncWidget(nodes, syncWidgetView({ running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0,
            outcome: null, complete: false, caughtUp: false, gapMissing: null, pausedUntil: null, quiet: false, username: null }, new Date()));
          syncStatus.textContent = 'Sync interrupted — tap Sync to resume.';
          return;
        }
        render(s);
        if (s.running) setTimeout(poll, 1500);
      });
    };
    syncBtn.addEventListener('click', async () => {
      if (latestView?.action?.kind === 'stop') {
        syncBtn.disabled = true;
        syncStatus.textContent = 'Stopping…';
        chrome.runtime.sendMessage({ type: 'checkin-sync:stop' }, () => { void chrome.runtime.lastError; });
        return;
      }
      const clearFirst = latestView?.action?.kind === 'clear';
      syncBtn.disabled = true;
      syncStatus.textContent = clearFirst ? 'Clearing…' : 'Starting…';
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
      if (clearFirst) {
        // After the permission request: the gesture is spent on it, and confirm() needs none.
        if (!window.confirm(CLEAR_QUESTION)) {
          syncStatus.textContent = '';
          syncBtn.disabled = false;
          return;
        }
        const cleared = await new Promise<boolean>((resolve) => {
          chrome.runtime.sendMessage({ type: 'local-db:clear' }, (reply?: { ok?: boolean }) => {
            void chrome.runtime.lastError;
            resolve(reply?.ok === true);
          });
        });
        if (!cleared) {
          syncStatus.textContent = 'Could not clear the check-ins stored in this browser.';
          syncBtn.disabled = false;
          return;
        }
        syncStatus.textContent = 'Starting…';
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

  armLiveRegions([el<HTMLElement>('syncStatus'), el<HTMLElement>('syncLabel'), refreshStatus, el<HTMLElement>('clearStatus')]);
}

if (typeof document !== 'undefined' && document.getElementById('refresh')) {
  void initPopup();
}
