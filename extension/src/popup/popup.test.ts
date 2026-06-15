import { describe, it, expect } from 'vitest';
import { canRefresh, formatSyncStatus } from './popup';

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
      .toBe('Synced 5000 of 8200 — tap Sync again to continue.');
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
});
