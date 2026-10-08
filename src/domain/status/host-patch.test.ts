import { describe, it, expect } from 'vitest';
import type { Avail, HostPatchFacts } from './types';
import { hostPatchFindings } from './host-patch';
import { NOW } from './test-inputs';

/** #469 stage 2 — spec rules table. NOW = 2026-10-06T07:00:00Z. */
const DAY = 86_400;
const T = NOW.getTime() / 1000;

const FACTS: HostPatchFacts = {
  timestamp: T - 600,
  kernel: { running: '6.8.0-142-generic', newestInstalled: '6.8.0-142-generic' },
  rebootRequired: null,
  livepatch: { state: 'nothing-to-apply', upgradeRequiredDate: '2027-10-02' },
  // code-server is not watched: 30 days stale must stay silent.
  staleServices: [{ unit: 'code-server@ysi.service', since: T - 30 * DAY }],
  unattended: { lastRun: T - 3600, securityPending: 0 },
  packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.11' },
};
const ok = (patch: Partial<HostPatchFacts> = {}): Avail<HostPatchFacts> => ({ ok: true, value: { ...FACTS, ...patch } });
const at = (iso: string) => new Date(iso);

describe('hostPatchFindings', () => {
  it('is silent on the real host of 2026-10-08', () => {
    expect(hostPatchFindings(ok(), NOW)).toEqual([]);
  });

  it('says "нема даних" for an unreadable summary', () => {
    expect(hostPatchFindings({ ok: false, reason: 'збирач патчів мовчить' }, NOW))
      .toEqual([{ colour: 'yellow', reason: 'нема даних: збирач патчів мовчить' }]);
  });

  describe('reboot pending', () => {
    const reboot = (since: number, packages = ['libc6', 'linux-image-6.8.0-145-generic']) =>
      hostPatchFindings(ok({ rebootRequired: { since, packages } }), NOW);

    it('is silent at exactly 3 days', () => {
      expect(reboot(T - 3 * DAY)).toEqual([]);
    });
    it('is yellow one second past 3 days', () => {
      expect(reboot(T - 3 * DAY - 1)).toEqual([
        { colour: 'yellow', reason: 'ядро: перезавантаження чекає 3 дні (libc6, linux-image-6.8.0-145-generic)' }]);
    });
    it('is still yellow at exactly 14 days', () => {
      expect(reboot(T - 14 * DAY)[0].colour).toBe('yellow');
    });
    it('is red one second past 14 days', () => {
      expect(reboot(T - 14 * DAY - 1)).toEqual([
        { colour: 'red', reason: 'ядро: перезавантаження чекає 14 днів (libc6, linux-image-6.8.0-145-generic)' }]);
    });
    it('shows at most three packages', () => {
      expect(reboot(T - 5 * DAY, ['a', 'b', 'c', 'd'])).toEqual([
        { colour: 'yellow', reason: 'ядро: перезавантаження чекає 5 днів (a, b, c, …)' }]);
    });
    it('drops the parentheses without a package list', () => {
      expect(reboot(T - 5 * DAY, [])).toEqual([{ colour: 'yellow', reason: 'ядро: перезавантаження чекає 5 днів' }]);
    });
  });

  describe('Livepatch', () => {
    const lp = (livepatch: HostPatchFacts['livepatch']) => hostPatchFindings(ok({ livepatch }), NOW);

    it('applied is silent', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2027-10-02' })).toEqual([]);
    });
    it.each(['unknown', 'unsupported-kernel'] as const)('%s is yellow', (state) => {
      expect(lp({ state, upgradeRequiredDate: null })).toEqual([{ colour: 'yellow', reason: `Livepatch: ${state}` }]);
    });
    it('unreadable is "нема даних"', () => {
      expect(lp(null)).toEqual([{ colour: 'yellow', reason: 'нема даних: стан Livepatch' }]);
    });
    it('a support end 30 days away is silent', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2026-11-06' })).toEqual([]);
    });
    it('a support end 29 days away is yellow', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2026-11-05' })).toEqual([
        { colour: 'yellow', reason: 'Livepatch покриває ядро лише до 2026-11-05' }]);
    });
    it('a support end of today is red', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2026-10-06' })).toEqual([
        { colour: 'red', reason: 'Livepatch більше не покриває ядро (з 2026-10-06)' }]);
    });
    it('an impossible date is "нема даних"', () => {
      expect(lp({ state: 'applied', upgradeRequiredDate: '2027-02-30' })).toEqual([
        { colour: 'yellow', reason: 'нема даних: дата підтримки ядра в Livepatch' }]);
    });
  });

  describe('stale watched units', () => {
    const stale = (unit: string, since: number) =>
      hostPatchFindings(ok({ staleServices: [...FACTS.staleServices!, { unit, since }] }), NOW);

    it.each(['warsaw-beer-bot.service', 'cloudflared.service', 'litestream.service', 'ssh.service'])(
      '%s one second past a day is yellow', (unit) => {
        expect(stale(unit, T - DAY - 1)).toEqual([
          { colour: 'yellow', reason: `${unit} не перезапущено після оновлення бібліотек: 1 день` }]);
      });
    it('exactly a day is silent', () => {
      expect(stale('litestream.service', T - DAY)).toEqual([]);
    });
    it('an unwatched unit is silent however old', () => {
      expect(stale('dbus.service', T - 90 * DAY)).toEqual([]);
    });
    it('unreadable is "нема даних"', () => {
      expect(hostPatchFindings(ok({ staleServices: null }), NOW))
        .toEqual([{ colour: 'yellow', reason: 'нема даних: needrestart' }]);
    });
  });

  describe('security backlog', () => {
    const backlog = (securityPending: number | null, lastRun: number | null) =>
      hostPatchFindings(ok({ unattended: { securityPending, lastRun } }), NOW);

    it('pending with a run exactly 2 days ago is silent', () => {
      expect(backlog(2, T - 2 * DAY)).toEqual([]);
    });
    it('pending with the last run one second past 2 days is yellow', () => {
      expect(backlog(2, T - 2 * DAY - 1)).toEqual([
        { colour: 'yellow', reason: 'безпекових оновлень чекає 2, unattended-upgrades не запускався 2 дні' }]);
    });
    it('pending and never run is yellow', () => {
      expect(backlog(1, null)).toEqual([
        { colour: 'yellow', reason: 'безпекових оновлень чекає 1, unattended-upgrades ще не запускався' }]);
    });
    it('nothing pending is silent however old the last run', () => {
      expect(backlog(0, T - 60 * DAY)).toEqual([]);
    });
    it('unreadable is "нема даних"', () => {
      expect(backlog(null, T)).toEqual([{ colour: 'yellow', reason: 'нема даних: безпекові оновлення' }]);
    });
  });

  describe('Ubuntu 24.04 end of standard support (2029-05-31)', () => {
    const quiet = ok({ livepatch: { state: 'applied', upgradeRequiredDate: null }, staleServices: [] });

    it('180 days before is silent', () => {
      expect(hostPatchFindings(quiet, at('2028-12-02T00:00:00Z'))).toEqual([]);
    });
    it('179 days before is yellow', () => {
      expect(hostPatchFindings(quiet, at('2028-12-03T00:00:00Z'))).toEqual([
        { colour: 'yellow', reason: 'Ubuntu 24.04: стандартна підтримка до 2029-05-31 — лишилось 179 днів' }]);
    });
    it('29 days before is red', () => {
      expect(hostPatchFindings(quiet, at('2029-05-02T00:00:00Z'))).toEqual([
        { colour: 'red', reason: 'Ubuntu 24.04: стандартна підтримка до 2029-05-31 — лишилось 29 днів' }]);
    });
    it('after the end it is red and still reported when the summary is unreadable', () => {
      expect(hostPatchFindings({ ok: false, reason: 'збирач патчів мовчить' }, at('2029-06-01T00:00:00Z'))).toEqual([
        { colour: 'red', reason: 'Ubuntu 24.04: стандартна підтримка до 2029-05-31 — уже минула' },
        { colour: 'yellow', reason: 'нема даних: збирач патчів мовчить' },
      ]);
    });
  });
});
