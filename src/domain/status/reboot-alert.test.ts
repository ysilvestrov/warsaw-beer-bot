import { describe, expect, it } from 'vitest';
import type { HostPatchFacts, HostPatchRead } from './types';
import { decideRebootAlert, snoozeRebootAlert } from './reboot-alert';

/** #469 stage 3 — spec "Immediate alert", claims C19/C23. */
const DAY = 86_400;
const T = 1_791_461_800;
const NOW = new Date(T * 1000);
const SINCE = T - 4 * DAY;
const FACTS: HostPatchFacts = {
  timestamp: T - 600,
  kernel: { running: '6.8.0-142-generic', newestInstalled: '6.8.0-142-generic' },
  rebootRequired: { since: SINCE, packages: ['libc6', 'dbus'] },
  livepatch: { state: 'nothing-to-apply', upgradeRequiredDate: '2027-10-02' },
  staleServices: [],
  unattended: { lastRun: T - 3600, securityPending: 0 },
  packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.17' },
};
const ok = (patch: Partial<HostPatchFacts> = {}): HostPatchRead => ({ kind: 'ok', facts: { ...FACTS, ...patch } });
const TEXT = '🔁 Хосту потрібне перезавантаження — чекає 4 дні: libc6, dbus.\nLivepatch: nothing-to-apply.';

describe('decideRebootAlert', () => {
  it('a newly pending reboot is alerted once', () => {
    expect(decideRebootAlert(ok(), null, NOW)).toEqual({ send: true, text: TEXT, state: { since: SINCE, snoozeUntil: null } });
  });

  it('the same pending reboot is not alerted again', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: null }, NOW))
      .toEqual({ send: false, state: { since: SINCE, snoozeUntil: null } });
  });

  it('a different since is a new reboot and is alerted', () => {
    expect(decideRebootAlert(ok(), { since: SINCE - DAY, snoozeUntil: null }, NOW).send).toBe(true);
  });

  it('a new since while the old one is snoozed is a new reboot and is alerted', () => {
    expect(decideRebootAlert(ok(), { since: SINCE - DAY, snoozeUntil: T + DAY }, NOW))
      .toEqual({ send: true, text: TEXT, state: { since: SINCE, snoozeUntil: null } });
  });

  it('caps the package list at 10 and marks the rest with an ellipsis', () => {
    const packages = Array.from({ length: 11 }, (_, i) => `pkg${i + 1}`);
    expect(decideRebootAlert(ok({ rebootRequired: { since: SINCE, packages } }), null, NOW)).toMatchObject({
      text: '🔁 Хосту потрібне перезавантаження — чекає 4 дні: pkg1, pkg2, pkg3, pkg4, pkg5, pkg6, pkg7, pkg8, pkg9, pkg10, ….\nLivepatch: nothing-to-apply.',
    });
  });

  it('exactly 10 packages are listed in full', () => {
    const packages = Array.from({ length: 10 }, (_, i) => `pkg${i + 1}`);
    expect(decideRebootAlert(ok({ rebootRequired: { since: SINCE, packages } }), null, NOW)).toMatchObject({
      text: '🔁 Хосту потрібне перезавантаження — чекає 4 дні: pkg1, pkg2, pkg3, pkg4, pkg5, pkg6, pkg7, pkg8, pkg9, pkg10.\nLivepatch: nothing-to-apply.',
    });
  });

  it('under a day of waiting there is no wait clause (with packages)', () => {
    expect(decideRebootAlert(ok({ rebootRequired: { since: T - 3600, packages: ['libc6'] } }), null, NOW)).toMatchObject({
      text: '🔁 Хосту потрібне перезавантаження: libc6.\nLivepatch: nothing-to-apply.',
    });
  });

  it('under a day of waiting there is no wait clause (without packages)', () => {
    expect(decideRebootAlert(ok({ rebootRequired: { since: T - 3600, packages: [] } }), null, NOW)).toMatchObject({
      text: '🔁 Хосту потрібне перезавантаження.\nLivepatch: nothing-to-apply.',
    });
  });

  it('an expired snooze alerts again and clears the snooze', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: T }, NOW))
      .toEqual({ send: true, text: TEXT, state: { since: SINCE, snoozeUntil: null } });
  });

  // AI review on #807: a stored snooze is a claim. Only snoozeRebootAlertNow writes it, never further
  // than 3 days ahead; anything later is corrupt and must not silence a pending reboot.
  it('a snooze further away than 3 days is corrupt: the reboot is alerted', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: T + 3 * DAY + 1 }, NOW).send).toBe(true);
  });

  it('a snooze exactly 3 days away is honoured', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: T + 3 * DAY }, NOW).send).toBe(false);
  });

  it('a snooze one second from expiry stays quiet', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: T + 1 }, NOW))
      .toEqual({ send: false, state: { since: SINCE, snoozeUntil: T + 1 } });
  });

  it('no pending reboot clears the state', () => {
    expect(decideRebootAlert(ok({ rebootRequired: null }), { since: SINCE, snoozeUntil: null }, NOW))
      .toEqual({ send: false, state: null });
  });

  it.each([{ kind: 'stale' }, { kind: 'unavailable' }] as const)('an unreadable summary (%j) sends nothing and keeps the state', (hp) => {
    expect(decideRebootAlert(hp, { since: SINCE, snoozeUntil: null }, NOW))
      .toEqual({ send: false, state: { since: SINCE, snoozeUntil: null } });
  });

  it('says "нема даних" for an unreadable Livepatch and names no kernel', () => {
    expect(decideRebootAlert(ok({ livepatch: null, rebootRequired: { since: SINCE, packages: [] } }), null, NOW)).toEqual({
      send: true,
      text: '🔁 Хосту потрібне перезавантаження — чекає 4 дні.\nLivepatch: нема даних.',
      state: { since: SINCE, snoozeUntil: null },
    });
  });
});

describe('snoozeRebootAlert', () => {
  it('snoozes for exactly 3 days from now', () => {
    expect(snoozeRebootAlert({ since: SINCE, snoozeUntil: null }, NOW)).toEqual({ since: SINCE, snoozeUntil: T + 3 * DAY });
  });
});
