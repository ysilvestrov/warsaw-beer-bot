import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canRefresh, formatSyncStatus, authNoteText, guideLinkVisible, requestSyncStart, syncButtonLabel, armLiveRegions, refreshResultText } from './popup';
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

describe('guideLinkVisible', () => {
  it('shows the guide link only when there is no token', () => {
    expect(guideLinkVisible(false)).toBe(true);
    expect(guideLinkVisible(true)).toBe(false);
  });
  it('links to the hosted setup guide', () => {
    expect(SETUP_GUIDE_URL).toContain('/install/');
  });
});

describe('refreshResultText', () => {
  it('reads as success when there was nothing to do', () => {
    expect(refreshResultText(0)).toBe('Nothing to refresh — badges are current.');
  });
  it('says what will happen next', () => {
    expect(refreshResultText(3)).toBe('Refreshed — 3 entries will be rechecked.');
    expect(refreshResultText(1)).toBe('Refreshed — 1 entry will be rechecked.');
  });
});

describe('armLiveRegions', () => {
  it('marks each node polite and tolerates missing ones', () => {
    const a = document.createElement('p');
    armLiveRegions([a, null]);
    expect(a.getAttribute('aria-live')).toBe('polite');
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
});
