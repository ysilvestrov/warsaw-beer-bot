import { afterEach, describe, it, expect, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canRefresh, authNoteText, requestSyncStart, armLiveRegions, refreshResultText, refreshReplyText, beers,
  count, syncPercent, syncWidgetView, type SyncStatusView } from './popup';
import { SETUP_GUIDE_URL } from '../shared/config';

describe('canRefresh', () => {
  it('true on a supported shop URL', () => {
    expect(canRefresh('https://beerfreak.org/some/page')).toBe(true);
    expect(canRefresh('https://winetime.com.ua/x')).toBe(true);
  });
  it('false on an unsupported URL', () => {
    expect(canRefresh('https://example.com/')).toBe(false);
  });
  it('false on a malformed or empty URL', () => {
    expect(canRefresh('not a url')).toBe(false);
    expect(canRefresh('')).toBe(false);
  });
});

const base: SyncStatusView = { running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: null,
  complete: false, caughtUp: false, gapMissing: null, pausedUntil: null, quiet: false, username: null };
const NOW = new Date('2026-11-01T12:00:00.000Z');
const none = { bar: null, detail: null, action: null, link: null, tone: 'neutral' };
const untappd = { text: 'Open untappd.com', href: 'https://untappd.com/' };
const N = '\u202f';

describe('syncPercent', () => {
  it('floors the honest share of the counts', () => {
    expect(syncPercent(0, 12407)).toBe(0);
    expect(syncPercent(5210, 12407)).toBe(41);
    expect(syncPercent(12406, 12407)).toBe(99);
    expect(syncPercent(12407, 12407)).toBe(100);
  });
  it('never goes past 100 when the server knows more than the profile says', () => {
    expect(syncPercent(12500, 12407)).toBe(100);
  });
  it('has no percentage without a positive profile total', () => {
    expect(syncPercent(10, null)).toBe(null);
    expect(syncPercent(10, 0)).toBe(null);
  });
});

describe('count', () => {
  it('groups thousands with a narrow no-break space', () => {
    expect(count(12407)).toBe(`12${N}407`);
    expect(count(999)).toBe('999');
    expect(count(1234567)).toBe(`1${N}234${N}567`);
  });
});

// #934 §6: one row of the widget table per test.
describe('syncWidgetView', () => {
  it('a running sync shows the percentage, the counts and Stop', () => {
    expect(syncWidgetView({ ...base, running: true, serverCount: 5210, profileTotal: 12407 }, NOW)).toEqual({ ...none,
      label: `Syncing… 41${N}%`, bar: 41, detail: `5${N}210 of 12${N}407`, action: { kind: 'stop', label: 'Stop' } });
  });
  it('a running sync with the total unknown shows an empty bar and the count only', () => {
    expect(syncWidgetView({ ...base, running: true, serverCount: 5210 }, NOW)).toEqual({ ...none,
      label: 'Syncing…', bar: 'unknown', detail: `5${N}210 check-ins`, action: { kind: 'stop', label: 'Stop' } });
  });
  it('done and caught up: the tick, a full bar, no action', () => {
    expect(syncWidgetView({ ...base, outcome: 'done', serverCount: 12407, profileTotal: 12407, caughtUp: true }, NOW)).toEqual({ ...none,
      label: '✓ Fully synced', bar: 100, detail: `12${N}407 check-ins` });
  });
  // The requirement of #934: equal counts are not a proven history.
  it('done with equal counts but not caught up: 100 %, Synced N of N and Sync again, never the tick', () => {
    expect(syncWidgetView({ ...base, outcome: 'done', serverCount: 12407, profileTotal: 12407, complete: true }, NOW)).toEqual({ ...none,
      label: `Synced 12${N}407 of 12${N}407`, bar: 100, action: { kind: 'start', label: 'Sync again' } });
  });
  it('done without a profile total: the count only', () => {
    expect(syncWidgetView({ ...base, outcome: 'done', serverCount: 1234 }, NOW)).toEqual({ ...none,
      label: `Synced 1${N}234`, bar: 'unknown', action: { kind: 'start', label: 'Sync again' } });
  });
  it('capped without an intent reads as a finished, not fully synced run', () => {
    expect(syncWidgetView({ ...base, outcome: 'capped', serverCount: 100, profileTotal: 100, caughtUp: true }, NOW)).toEqual({ ...none,
      label: 'Synced 100 of 100', bar: 100, action: { kind: 'start', label: 'Sync again' } });
  });
  it('a gap names the new check-ins and offers Sync', () => {
    expect(syncWidgetView({ ...base, outcome: 'gap', serverCount: 12255, profileTotal: 12407, gapMissing: 152 }, NOW)).toEqual({ ...none,
      label: '152 new check-ins', bar: 98, action: { kind: 'start', label: 'Sync' } });
  });
  it('a gap of one is singular', () => {
    expect(syncWidgetView({ ...base, outcome: 'gap', serverCount: 99, profileTotal: 100, gapMissing: 1 }, NOW).label).toBe('1 new check-in');
  });
  it('a gap without the missing count still offers Sync', () => {
    expect(syncWidgetView({ ...base, outcome: 'gap', serverCount: 99, profileTotal: 100 }, NOW)).toEqual({ ...none,
      label: 'New check-ins', bar: 99, action: { kind: 'start', label: 'Sync' } });
  });
  it('a quiet no_session only asks to sign in, with a link', () => {
    expect(syncWidgetView({ ...base, outcome: 'no_session', serverCount: 100, profileTotal: 120, quiet: true }, NOW)).toEqual({ ...none,
      label: 'Sign in to untappd.com to keep ✅ fresh', link: untappd });
  });
  it('a manual no_session is a pause with the link and Sync', () => {
    expect(syncWidgetView({ ...base, outcome: 'no_session', serverCount: 60, profileTotal: 120 }, NOW)).toEqual({ ...none,
      label: 'Paused: sign in to untappd.com', bar: 50, link: untappd, action: { kind: 'start', label: 'Sync' } });
  });
  it('blocked with the pause ahead says it resumes tomorrow and offers Try now', () => {
    expect(syncWidgetView({ ...base, outcome: 'blocked', serverCount: 60, profileTotal: 120, pausedUntil: '2026-11-02T00:00:00.000Z' }, NOW))
      .toEqual({ ...none, label: 'Paused: Untappd is limiting requests', bar: 50, detail: 'Resumes tomorrow',
        action: { kind: 'start', label: 'Try now' } });
  });
  it('blocked with the pause already over drops the promise', () => {
    expect(syncWidgetView({ ...base, outcome: 'blocked', serverCount: 60, profileTotal: 120, pausedUntil: '2026-11-01T12:00:00.000Z' }, NOW).detail)
      .toBe(null);
  });
  it('account_changed names the linked account', () => {
    expect(syncWidgetView({ ...base, outcome: 'account_changed', username: 'bob' }, NOW)).toEqual({ ...none,
      label: 'Untappd account changed', detail: 'Sign in as bob, then Sync', link: untappd, action: { kind: 'start', label: 'Sync' } });
  });
  it('account_changed without a known username asks for the linked account', () => {
    expect(syncWidgetView({ ...base, outcome: 'account_changed' }, NOW).detail).toBe('Sign in to the linked account, then Sync');
  });
  // #924 §6: in local mode the database belongs to one account — the person chooses to drop it.
  it('account_changed in local mode names the owner, links to untappd.com and offers Clear and sync', () => {
    expect(syncWidgetView({ ...base, outcome: 'account_changed', username: 'alice', mode: 'local' }, NOW)).toEqual({ ...none,
      label: 'Untappd account changed', detail: "This browser's check-ins belong to alice. Sign in as alice, or clear them and sync this account.",
      link: { text: 'Open untappd.com', href: 'https://untappd.com/' }, action: { kind: 'clear', label: 'Clear and sync' } });
  });
  it('account_changed in local mode without a known owner still offers both ways out', () => {
    expect(syncWidgetView({ ...base, outcome: 'account_changed', mode: 'local' }, NOW)).toEqual({ ...none,
      label: 'Untappd account changed', detail: 'Sign in to the account these check-ins belong to, or clear them and sync this account.',
      link: { text: 'Open untappd.com', href: 'https://untappd.com/' }, action: { kind: 'clear', label: 'Clear and sync' } });
  });
  it('not_linked points to /link', () => {
    expect(syncWidgetView({ ...base, outcome: 'not_linked' }, NOW)).toEqual({ ...none,
      label: 'Link Untappd in the bot', detail: 'Send /link to the bot' });
  });
  it('sync_context_required asks to update the extension', () => {
    expect(syncWidgetView({ ...base, outcome: 'sync_context_required' }, NOW)).toEqual({ ...none, label: 'Update the extension' });
  });
  it('feed_unavailable is red with Retry', () => {
    expect(syncWidgetView({ ...base, outcome: 'feed_unavailable', serverCount: 30, profileTotal: 120 }, NOW)).toEqual({ ...none,
      label: 'Untappd did not return your feed', bar: 25, tone: 'error', action: { kind: 'start', label: 'Retry' } });
  });
  it('page_rejected is red, keeps what was saved and suggests later or /import', () => {
    expect(syncWidgetView({ ...base, outcome: 'page_rejected', serverCount: 30, profileTotal: 120 }, NOW)).toEqual({ ...none,
      label: 'Untappd sent an unexpected page', bar: 25, tone: 'error', detail: 'Try again later, or use /import in the bot',
      action: { kind: 'start', label: 'Retry' } });
  });
  it('error is red with Retry', () => {
    expect(syncWidgetView({ ...base, outcome: 'error', serverCount: 30, profileTotal: 120 }, NOW)).toEqual({ ...none,
      label: 'Sync failed', bar: 25, tone: 'error', action: { kind: 'start', label: 'Retry' } });
  });
  it('cancelled says where it stopped', () => {
    expect(syncWidgetView({ ...base, outcome: 'cancelled', serverCount: 5210, profileTotal: 12407 }, NOW)).toEqual({ ...none,
      label: `Stopped at 41${N}%`, bar: 41, action: { kind: 'start', label: 'Sync' } });
  });
  it('cancelled without a profile total says the count', () => {
    expect(syncWidgetView({ ...base, outcome: 'cancelled', serverCount: 5210 }, NOW).label).toBe(`Stopped at 5${N}210`);
  });
  it('before any sync: no label, no bar, the start button', () => {
    expect(syncWidgetView(base, NOW)).toEqual({ ...none, label: '', action: { kind: 'start', label: 'Sync my check-ins' } });
  });
});

describe('requestSyncStart', () => {
  afterEach(() => vi.useRealTimers());

  it('does not retry after the first runtime callback arrives', async () => {
    const sendStart = vi.fn((callback: () => void) => { callback(); });

    await expect(requestSyncStart(sendStart, 1000)).resolves.toBe(true);
    expect(sendStart).toHaveBeenCalledTimes(1);
  });

  it('retries once when the first runtime callback never arrives', async () => {
    vi.useFakeTimers();
    const callbacks: (() => void)[] = [];
    const sendStart = vi.fn((callback: () => void) => { callbacks.push(callback); });

    const acknowledged = requestSyncStart(sendStart, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendStart).toHaveBeenCalledTimes(2);
    callbacks[1]!();

    await expect(acknowledged).resolves.toBe(true);
  });

  it('returns after the retry timeout so polling can recover the popup', async () => {
    vi.useFakeTimers();
    const sendStart = vi.fn((_callback: () => void) => {});

    const acknowledged = requestSyncStart(sendStart, 1000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(acknowledged).resolves.toBe(false);
    expect(sendStart).toHaveBeenCalledTimes(2);
  });
});

describe('authNoteText', () => {
  it('without any token, names what local mode gives and what a bot token adds (#924)', () => {
    expect(authNoteText(false)).toBe(
      'Works without Telegram — ⭐ global ratings and ✅ from check-ins you sync into this browser only. A bot token adds recommendations and sync across devices.',
    );
  });
  it('returns null when a token is present', () => {
    expect(authNoteText(true)).toBeNull();
  });
  it('with an install token, adds missing-beer search (#923, #924)', () => {
    expect(authNoteText(false, true)).toBe(
      'Works without Telegram — ⭐ global ratings, missing-beer search, and ✅ from check-ins you sync into this browser only. A bot token adds recommendations and sync across devices.',
    );
  });
});

describe('beers', () => {
  it('pluralizes a beer count', () => {
    expect(beers(1)).toBe('1 beer');
    expect(beers(3)).toBe('3 beers');
    expect(beers(0)).toBe('0 beers');
  });
});

describe('refreshResultText', () => {
  it('reads zero as "no beer cards found on this page", not "cache already warm"', () => {
    expect(refreshResultText(0)).toBe('Nothing to refresh — no beers found on this page.');
  });
  it('says what will happen next', () => {
    expect(refreshResultText(3)).toBe('Refreshed — 3 beers will be rechecked.');
    expect(refreshResultText(1)).toBe('Refreshed — 1 beer will be rechecked.');
  });
});

describe('refreshReplyText', () => {
  it('reports a transport failure regardless of what the reply carries', () => {
    expect(refreshReplyText(undefined, true)).toBe('Could not reach the page — reload it and retry.');
    expect(refreshReplyText({ ok: true, cleared: 5 }, true)).toBe('Could not reach the page — reload it and retry.');
  });
  it('reports a content-script failure distinctly from a zero-count success (#518)', () => {
    expect(refreshReplyText({ ok: false, cleared: 0 }, false)).toBe('Refresh failed — reload the page and try again.');
  });
  it('falls through to the result text on success', () => {
    expect(refreshReplyText({ ok: true, cleared: 3 }, false)).toBe('Refreshed — 3 beers will be rechecked.');
    expect(refreshReplyText(undefined, false)).toBe('Nothing to refresh — no beers found on this page.');
  });
});

describe('armLiveRegions', () => {
  it('marks each node polite and tolerates missing ones', () => {
    const a = document.createElement('p');
    armLiveRegions([a, null]);
    expect(a.getAttribute('aria-live')).toBe('polite');
  });
});

describe('armLiveRegions call site (popup.ts)', () => {
  const source = readFileSync(resolve(__dirname, 'popup.ts'), 'utf8');
  const call = source.match(/armLiveRegions\(\[([\s\S]*?)\]\);/)?.[1] ?? '';

  it('found the call', () => {
    expect(call).not.toBe('');
  });
  it('arms syncStatus, refreshStatus and clearStatus (#524)', () => {
    expect(call).toMatch(/'syncStatus'/);
    expect(call).toMatch(/\brefreshStatus\b/);
    expect(call).toMatch(/'clearStatus'/);
  });
  it('never arms authNote — it is static text, not a response to a click (#524)', () => {
    expect(call).not.toMatch(/authNote/);
  });
});

describe('initPopup', () => {
  const html = readFileSync(resolve(__dirname, 'popup.html'), 'utf8');

  async function bootPopup(token: string, statusReply?: object) {
    // Only the body content: assigning a fragment to documentElement would leave
    // jsdom without a <body> for popup.ts to query.
    document.body.innerHTML = html.split('<body>')[1].split('</body>')[0];
    const sendMessage = vi.fn((_m: { type?: string }, callback?: (r?: object) => void) => {
      callback?.(statusReply);
    });
    const chromeStub = globalThis.chrome as unknown as Record<string, unknown>;
    await (chromeStub.storage as { local: { set(o: object): Promise<void> } }).local.set({ token });
    chromeStub.tabs = { query: vi.fn(async () => [{ id: 7, url: 'https://beerfreak.org/p/1' }]) };
    chromeStub.permissions = { request: vi.fn(async () => true) };
    (chromeStub.runtime as Record<string, unknown>).sendMessage = sendMessage;
    (chromeStub.runtime as Record<string, unknown>).openOptionsPage = vi.fn();
    vi.resetModules();
    await import('./popup');
    await new Promise((r) => setTimeout(r, 0));
    return { sendMessage };
  }

  it('without a token: the widget shows, sync is enabled and its status is polled (#924)', async () => {
    const { sendMessage } = await bootPopup('');
    const syncBtn = document.getElementById('syncCheckins') as HTMLButtonElement;
    expect((document.getElementById('syncWidget') as HTMLElement).hidden).toBe(false);
    expect(syncBtn.disabled).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'checkin-sync:status' }, expect.any(Function));
  });

  it('without a token: Clear and sync asks for the permission, clears, then starts — in that order (#924)', async () => {
    const reply = { type: 'checkin-sync:status:ok', running: false, serverCount: 5, profileTotal: 5, mergedThisRun: 0,
      outcome: 'account_changed', complete: false, caughtUp: false, gapMissing: null, pausedUntil: null, quiet: false, username: 'alice' };
    await bootPopup('', reply);
    expect(document.querySelector('#syncCheckins span')?.textContent).toBe('Clear and sync');
    const chromeStub = globalThis.chrome as unknown as { runtime: Record<string, unknown>; permissions: { request: Mock } };
    const send = vi.fn((m: { type?: string }, callback?: (r?: object) => void) => {
      callback?.(m.type === 'local-db:clear' ? { type: 'local-db:cleared', ok: true } : reply);
    });
    chromeStub.runtime.sendMessage = send;
    const ask = vi.fn(() => true);
    vi.stubGlobal('confirm', ask);
    (document.getElementById('syncCheckins') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'checkin-sync:start' }, expect.any(Function)));
    const types = send.mock.calls.map(([m]) => m.type);
    // #965: no waiting mark — a closed popup could not ask the question the deletion needs.
    expect(types.slice(0, 2)).toEqual(['local-db:clear', 'checkin-sync:start']);
    expect(ask).toHaveBeenCalledWith('Delete the check-ins stored in this browser and sync this account?\n\n'
      + 'Cancel keeps them and only syncs — for when you have signed back in to the account they belong to.');
    // The permission prompt needs the click gesture, so it comes first; the question, before anything is sent.
    expect(chromeStub.permissions.request.mock.invocationCallOrder[0]).toBeLessThan(ask.mock.invocationCallOrder[0]);
    expect(ask.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    vi.unstubAllGlobals();
  });

  it('a press tells the worker it is waiting for the permission before asking for it (#965)', async () => {
    await bootPopup('');
    const chromeStub = globalThis.chrome as unknown as { runtime: Record<string, unknown>; permissions: { request: Mock } };
    const send = vi.fn((_m: { type?: string }, callback?: (r?: object) => void) => { callback?.(); });
    chromeStub.runtime.sendMessage = send;
    (document.getElementById('syncCheckins') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'checkin-sync:start' }, expect.any(Function)));
    expect(send.mock.calls[0][0]).toEqual({ type: 'checkin-sync:awaiting-permission' });
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(chromeStub.permissions.request.mock.invocationCallOrder[0]);
  });

  it('a declined permission withdraws the press and starts nothing (#965)', async () => {
    await bootPopup('');
    const chromeStub = globalThis.chrome as unknown as { runtime: Record<string, unknown>; permissions: { request: Mock } };
    chromeStub.permissions.request.mockResolvedValue(false);
    const send = vi.fn((_m: { type?: string }, callback?: (r?: object) => void) => { callback?.(); });
    chromeStub.runtime.sendMessage = send;
    (document.getElementById('syncCheckins') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById('syncStatus')?.textContent)
      .toBe('Allow access to untappd.com to sync your check-ins.'));
    expect(send.mock.calls.map(([m]) => m.type)).toEqual(['checkin-sync:awaiting-permission', 'checkin-sync:not-starting']);
  });

  it('without a token: Clear and sync answered Cancel keeps the check-ins and only syncs (#924)', async () => {
    const reply = { type: 'checkin-sync:status:ok', running: false, serverCount: 5, profileTotal: 5, mergedThisRun: 0,
      outcome: 'account_changed', complete: false, caughtUp: false, gapMissing: null, pausedUntil: null, quiet: false, username: 'alice' };
    await bootPopup('', reply);
    const send = vi.fn((_m: { type?: string }, callback?: (r?: object) => void) => { callback?.(reply); });
    (globalThis.chrome as unknown as { runtime: Record<string, unknown> }).runtime.sendMessage = send;
    vi.stubGlobal('confirm', vi.fn(() => false));
    (document.getElementById('syncCheckins') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'checkin-sync:start' }, expect.any(Function)));
    expect(send).not.toHaveBeenCalledWith({ type: 'local-db:clear' }, expect.any(Function));
    vi.unstubAllGlobals();
  });

  it('without a token: a refused Clear does not start a sync (#924)', async () => {
    const reply = { type: 'checkin-sync:status:ok', running: false, serverCount: 5, profileTotal: 5, mergedThisRun: 0,
      outcome: 'account_changed', complete: false, caughtUp: false, gapMissing: null, pausedUntil: null, quiet: false, username: 'alice' };
    await bootPopup('', reply);
    const send = vi.fn((m: { type?: string }, callback?: (r?: object) => void) => {
      callback?.(m.type === 'local-db:clear' ? { type: 'local-db:cleared', ok: false } : reply);
    });
    (globalThis.chrome as unknown as { runtime: Record<string, unknown> }).runtime.sendMessage = send;
    vi.stubGlobal('confirm', vi.fn(() => true));
    (document.getElementById('syncCheckins') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById('syncStatus')?.textContent).toBe('Could not clear the check-ins stored in this browser.'));
    expect(send).not.toHaveBeenCalledWith({ type: 'checkin-sync:start' }, expect.any(Function));
    vi.unstubAllGlobals();
  });

  it('without a token: the auth block leads and the guide sits inside it (#519, #522)', async () => {
    await bootPopup('');
    const header = document.querySelector('header.head');
    const authBlock = document.getElementById('authBlock') as HTMLElement;
    expect(header?.nextElementSibling).toBe(authBlock);
    expect(authBlock.contains(document.getElementById('guideLink'))).toBe(true);
    expect((document.getElementById('guideLink') as HTMLElement).style.display).toBe('');
  });

  it('with a token: the guide link stays visible in the footer (#522)', async () => {
    await bootPopup('tok');
    const guide = document.getElementById('guideLink') as HTMLAnchorElement;
    expect(document.querySelector('footer.foot')?.contains(guide)).toBe(true);
    expect(guide.style.display).toBe('');
    expect(guide.href).toBe(SETUP_GUIDE_URL);
    expect((document.getElementById('authBlock') as HTMLElement).style.display).toBe('none');
  });

  it('with a token: a gap reply renders the label, the bar and Sync (#934)', async () => {
    const reply = { type: 'checkin-sync:status:ok', running: false, serverCount: 88, profileTotal: 100, mergedThisRun: 0,
      outcome: 'gap', complete: false, caughtUp: false, gapMissing: 12, pausedUntil: null, quiet: false, username: 'bob' };
    const { sendMessage } = await bootPopup('tok', reply);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'checkin-sync:status' }, expect.any(Function));
    expect(document.getElementById('syncLabel')?.textContent).toBe('12 new check-ins');
    expect(document.getElementById('syncBar')?.getAttribute('aria-valuenow')).toBe('88');
    expect((document.getElementById('syncBar') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector('#syncCheckins span')?.textContent).toBe('Sync');
    expect((document.getElementById('syncCheckins') as HTMLButtonElement).hidden).toBe(false);
  });

  it('with a token: a fully synced reply hides the sync button (#934)', async () => {
    const reply = { type: 'checkin-sync:status:ok', running: false, serverCount: 100, profileTotal: 100, mergedThisRun: 0,
      outcome: 'done', complete: true, caughtUp: true, gapMissing: null, pausedUntil: null, quiet: false, username: 'bob' };
    await bootPopup('tok', reply);
    expect(document.getElementById('syncLabel')?.textContent).toBe('✓ Fully synced');
    expect((document.getElementById('syncCheckins') as HTMLButtonElement).hidden).toBe(true);
  });

  it('with a token: sync is primary and its status is polled', async () => {
    const { sendMessage } = await bootPopup('tok');
    const syncBtn = document.getElementById('syncCheckins') as HTMLButtonElement;
    expect(syncBtn.classList.contains('btn-primary')).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'checkin-sync:status' }, expect.any(Function));
  });
});

describe('popup markup', () => {
  const html = readFileSync(resolve(__dirname, 'popup.html'), 'utf8');

  it('ships no aria-live in the markup — regions are armed after init (#524)', () => {
    expect(html).not.toContain('aria-live');
  });
  it('gives the destructive action its own caption next to it (#518)', () => {
    expect(html).toContain('id="clearStatus"');
    expect(html).toContain('id="refreshStatus"');
    expect(html).not.toContain('id="status"');
  });
  it('adds no heading beyond the title (#524 sub-item dropped by design)', () => {
    expect(html).not.toContain('<h2');
  });
  it('pairs no description with the live caption (#518: describedby stays off)', () => {
    expect(html).not.toContain('aria-describedby');
  });

  it('wraps the note and Get a token in one movable block (#519)', () => {
    expect(html).toContain('id="authBlock"');
    const block = html.match(/<section id="authBlock"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(block).toContain('id="authNote"');
    expect(block).toContain('id="getToken"');
  });

  it('parks the guide link in the footer ahead of the destructive action (#522)', () => {
    const foot = html.match(/<footer class="foot">[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(foot).toContain('id="guideLink"');
    expect(foot.indexOf('id="guideLink"')).toBeLessThan(foot.indexOf('id="clearAll"'));
  });

  it('ships the auth block and the guide link hidden, so init places them before they are seen', () => {
    const block = html.match(/<section id="authBlock"[^>]*>/)?.[0] ?? '';
    expect(block).toContain('display:none');
    const link = html.match(/<a id="guideLink"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('display:none');
  });
});

