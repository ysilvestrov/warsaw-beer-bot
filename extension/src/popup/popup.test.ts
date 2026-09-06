import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canRefresh, formatSyncStatus, authNoteText, requestSyncStart, syncButtonLabel, armLiveRegions, refreshResultText, refreshReplyText, beers } from './popup';
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

describe('formatSyncStatus', () => {
  it('shows progress while running', () => {
    expect(formatSyncStatus({ running: true, serverCount: 1200, profileTotal: 8200, mergedThisRun: 30, outcome: null, complete: false }))
      .toBe('Syncing… 1200 / 8200');
  });
  it('shows count only when total is unknown', () => {
    expect(formatSyncStatus({ running: true, serverCount: 1200, profileTotal: null, mergedThisRun: 30, outcome: null, complete: false }))
      .toBe('Syncing… 1200');
  });
  it('prompts to continue when capped', () => {
    expect(formatSyncStatus({ running: false, serverCount: 5000, profileTotal: 8200, mergedThisRun: 5000, outcome: 'capped', complete: false }))
      .toBe('Synced 5000 of 8200.');
  });
  it('reports full sync on completion', () => {
    expect(formatSyncStatus({ running: false, serverCount: 8200, profileTotal: 8200, mergedThisRun: 100, outcome: 'done', complete: true }))
      .toBe('✓ Fully synced (8200).');
  });
  it('tells unlinked users to link first', () => {
    expect(formatSyncStatus({ running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: 'not_linked', complete: false }))
      .toBe('Link your Untappd account in the bot first (/link).');
  });
  it('reports rate limiting', () => {
    expect(formatSyncStatus({ running: false, serverCount: 10, profileTotal: 8200, mergedThisRun: 10, outcome: 'blocked', complete: false }))
      .toBe('Untappd is rate-limiting — try again later.');
  });
  it('reports a transient error', () => {
    expect(formatSyncStatus({ running: false, serverCount: 10, profileTotal: 8200, mergedThisRun: 10, outcome: 'error', complete: false }))
      .toBe('Sync failed — check your connection and token, then retry.');
  });
  it('reports done-but-not-fully-synced when complete is false', () => {
    expect(formatSyncStatus({ running: false, serverCount: 5000, profileTotal: 8200, mergedThisRun: 200, outcome: 'done', complete: false }))
      .toBe('Synced 5000 of 8200.');
  });
  it('returns empty string for the idle/never-started state', () => {
    expect(formatSyncStatus({ running: false, serverCount: 0, profileTotal: null, mergedThisRun: 0, outcome: null, complete: false }))
      .toBe('');
  });
  it('shows ? for total when capped and total is unknown', () => {
    expect(formatSyncStatus({ running: false, serverCount: 5000, profileTotal: null, mergedThisRun: 5000, outcome: 'capped', complete: false }))
      .toBe('Synced 5000.');
  });
  it('reports where a cancelled sync stopped', () => {
    expect(formatSyncStatus({ running: false, serverCount: 5000, profileTotal: 8200, mergedThisRun: 400, outcome: 'cancelled', complete: false }))
      .toBe('Sync stopped at 5000 of 8200.');
  });
  it('shows the tick when the counts agree', () => {
    expect(formatSyncStatus({ running: false, serverCount: 12634, profileTotal: 12634, mergedThisRun: 41, outcome: 'done', complete: true }))
      .toBe('✓ Fully synced (12634).');
  });
  it('tells the user to sign in to Untappd when the session is dead', () => {
    expect(formatSyncStatus({ running: false, serverCount: 10, profileTotal: 8200, mergedThisRun: 0, outcome: 'no_session', complete: false }))
      .toBe('Untappd session expired — open untappd.com, sign in, then sync again.');
  });
});

describe('syncButtonLabel', () => {
  it('offers Stop while a sync is running', () => {
    expect(syncButtonLabel({ running: true, serverCount: 100, profileTotal: 500, mergedThisRun: 100, outcome: null, complete: false }))
      .toBe('Stop');
  });

  it('shows the remaining count after the page cap', () => {
    expect(syncButtonLabel({ running: false, serverCount: 100, profileTotal: 500, mergedThisRun: 100, outcome: 'capped', complete: false }))
      .toBe('Continue — 400 left');
  });

  it('offers a generic continuation when the profile total is unknown', () => {
    expect(syncButtonLabel({ running: false, serverCount: 100, profileTotal: null, mergedThisRun: 100, outcome: 'capped', complete: false }))
      .toBe('Continue sync');
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
  it('returns the not-connected note when there is no token', () => {
    expect(authNoteText(false)).toBe(
      "Not connected — showing global ratings only (⭐). Add a token to see which beers you've had ✅ and your own rating.",
    );
  });
  it('returns null when a token is present', () => {
    expect(authNoteText(true)).toBeNull();
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

  async function bootPopup(token: string) {
    // Only the body content: assigning a fragment to documentElement would leave
    // jsdom without a <body> for popup.ts to query.
    document.body.innerHTML = html.split('<body>')[1].split('</body>')[0];
    const sendMessage = vi.fn();
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

  it('without a token: sync is disabled, captioned, and never polled (#519)', async () => {
    const { sendMessage } = await bootPopup('');
    const syncBtn = document.getElementById('syncCheckins') as HTMLButtonElement;
    expect(syncBtn.disabled).toBe(true);
    expect(document.getElementById('syncStatus')?.textContent).toBe('Add a token to sync your check-ins.');
    expect(sendMessage.mock.calls.some(([m]) => m?.type === 'checkin-sync:status')).toBe(false);
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

  it('with a token: sync is primary and its status is polled', async () => {
    const { sendMessage } = await bootPopup('tok');
    const syncBtn = document.getElementById('syncCheckins') as HTMLButtonElement;
    expect(syncBtn.classList.contains('btn-primary')).toBe(true);
    expect(sendMessage.mock.calls.some(([m]) => m?.type === 'checkin-sync:status')).toBe(true);
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
