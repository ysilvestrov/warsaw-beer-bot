import { describe, it, expect } from 'vitest';
import { canRefresh, formatSyncStatus, authNoteText } from './popup';

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
      .toBe('Synced 5000 of ? — tap Sync again to continue.');
  });
});

describe('authNoteText', () => {
  it('returns the not-authorized note when there is no token', () => {
    expect(authNoteText(false)).toBe(
      'Не авторизовано — показуються лише глобальні рейтинги (⭐). Додай токен, щоб бачити «вже пив» ✅ і свою оцінку.',
    );
  });
  it('returns null when a token is present', () => {
    expect(authNoteText(true)).toBeNull();
  });
});
