import { describe, expect, it } from 'vitest';
import type { HostPatchFacts } from './types';
import type { HostPatchRead } from '../../jobs/host-patch';
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

  it('an expired snooze alerts again and clears the snooze', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: T }, NOW))
      .toEqual({ send: true, text: TEXT, state: { since: SINCE, snoozeUntil: null } });
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
