import { describe, expect, it } from 'vitest';
import type { HostPatchFacts, HostUpstream } from './types';
import { debianUpstreamVersion, upstreamFindings } from './host-upstream';

/** #469 stage 2 — spec rules table, upstream rows. Today = 2026-10-08. */
const NOW = new Date('2026-10-08T07:00:00Z');
const PACKAGES: HostPatchFacts['packages'] = { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.17' };
const UP: HostUpstream = {
  nodeSecurity: { ok: true, value: { version: '24.18.1', date: '2026-07-28' } },
  nodeEnd: { ok: true, value: '2028-04-30' },
  litestream: { ok: true, value: { version: '0.5.17', publishedAt: '2026-08-31T21:59:32Z' } },
};
const at = (patch: Partial<HostUpstream>, packages: HostPatchFacts['packages'] | null = PACKAGES, now = NOW) =>
  upstreamFindings({ ...UP, ...patch }, packages, now);

describe('debianUpstreamVersion', () => {
  it.each([
    ['24.21.0-1nodesource1', '24.21.0'],
    ['0.5.11', '0.5.11'],
    ['1:2.39-0ubuntu8.7', '2.39'],
    ['2026.10.0', '2026.10.0'],
    ['2.9.14+dfsg-1.3ubuntu3.6', '2.9.14'],
    ['5', '5'],
    ['24.22.0~rc1', '24.22.0'],
  ])('%s → %s', (raw, expected) => {
    expect(debianUpstreamVersion(raw)).toBe(expected);
  });
  it.each(['', 'rc', '-1'])('%j is null', (raw) => {
    expect(debianUpstreamVersion(raw)).toBe(null);
  });
});

describe('upstreamFindings', () => {
  it('is silent on the real host of 2026-10-08 once litestream is current', () => {
    expect(at({})).toEqual([]);
  });

  describe('Node security release', () => {
    const security = (version: string, date: string) => ({ nodeSecurity: { ok: true as const, value: { version, date } } });
    it('a newer security release 4 days old is red', () => {
      expect(at(security('24.22.0', '2026-10-04'))).toEqual([
        { colour: 'red', reason: 'Node 24.21.0 < безпековий 24.22.0 (з 2026-10-04)' }]);
    });
    it('the same release 3 days old is silent (unattended-upgrades has time)', () => {
      expect(at(security('24.22.0', '2026-10-05'))).toEqual([]);
    });
    it('an installed version equal to the security release is silent', () => {
      expect(at(security('24.21.0', '2026-01-01'))).toEqual([]);
    });
    it('compares numerically: 24.9.0 is older than 24.10.0', () => {
      expect(at(security('24.10.0', '2026-01-01'), { ...PACKAGES, nodejs: '24.9.0-1nodesource1' })).toEqual([
        { colour: 'red', reason: 'Node 24.9.0 < безпековий 24.10.0 (з 2026-01-01)' }]);
    });
    it('a release dated tomorrow is silent', () => {
      expect(at(security('24.22.0', '2026-10-09'))).toEqual([]);
    });
    it('an impossible date is "нема даних", not a pass', () => {
      expect(at(security('24.22.0', '2026-02-30'))).toEqual([
        { colour: 'yellow', reason: 'нема даних: дата безпекового релізу Node' }]);
    });
    it('no security release in the line is silent', () => {
      expect(at({ nodeSecurity: { ok: true, value: null } })).toEqual([]);
    });
    it('an unreadable source is "нема даних"', () => {
      expect(at({ nodeSecurity: { ok: false, reason: 'безпекові релізи Node ще не завантажено' } })).toEqual([
        { colour: 'yellow', reason: 'нема даних: безпекові релізи Node ще не завантажено' }]);
    });
    it('an installed version dpkg could not name is "нема даних"', () => {
      expect(at({}, { ...PACKAGES, nodejs: null })).toEqual([
        { colour: 'yellow', reason: 'нема даних: встановлена версія nodejs' }]);
    });
    it('without a host summary the package rules stay quiet (the host line already says why)', () => {
      expect(at(security('24.22.0', '2026-10-01'), null)).toEqual([]);
    });
  });

  describe('Node 24 end of life', () => {
    const end = (value: string) => ({ nodeEnd: { ok: true as const, value } });
    it('180 days away is silent', () => {
      expect(at(end('2027-04-06'))).toEqual([]);
    });
    it('179 days away is yellow', () => {
      expect(at(end('2027-04-05'))).toEqual([
        { colour: 'yellow', reason: 'Node 24: підтримка до 2027-04-05 — лишилось 179 днів' }]);
    });
    it('30 days away is yellow, 29 is red', () => {
      expect([at(end('2026-11-07'))[0].colour, at(end('2026-11-06'))]).toEqual(['yellow', [
        { colour: 'red', reason: 'Node 24: підтримка до 2026-11-06 — лишилось 29 днів' }]]);
    });
    it('after the end it is red and reported even without a host summary', () => {
      expect(at(end('2026-10-07'), null)).toEqual([
        { colour: 'red', reason: 'Node 24: підтримка до 2026-10-07 — уже минула' }]);
    });
    it('an impossible date is "нема даних", not a false red', () => {
      expect(at(end('2026-02-30'))).toEqual([
        { colour: 'yellow', reason: 'нема даних: дата кінця підтримки Node 24' }]);
    });
    it('an unreadable schedule is "нема даних"', () => {
      expect(at({ nodeEnd: { ok: false, reason: 'графік підтримки Node застарів (понад 48 год)' } })).toEqual([
        { colour: 'yellow', reason: 'нема даних: графік підтримки Node застарів (понад 48 год)' }]);
    });
  });

  describe('litestream', () => {
    const latest = (version: string, publishedAt: string) =>
      ({ litestream: { ok: true as const, value: { version, publishedAt } } });
    it('the real host: 0.5.11 against 0.5.17 published 38 days ago is yellow', () => {
      expect(at({}, { ...PACKAGES, litestream: '0.5.11' })).toEqual([
        { colour: 'yellow', reason: 'litestream 0.5.11 < 0.5.17 (вийшов 2026-08-31)' }]);
    });
    it('a newer release 30 days old is silent; 31 days is yellow', () => {
      expect([at(latest('0.5.18', '2026-09-08T12:00:00Z')), at(latest('0.5.18', '2026-09-07T12:00:00Z'))]).toEqual([[], [
        { colour: 'yellow', reason: 'litestream 0.5.17 < 0.5.18 (вийшов 2026-09-07)' }]]);
    });
    it('an impossible release date is "нема даних", not a pass', () => {
      expect(at(latest('0.5.18', '2026-02-30T00:00:00Z'))).toEqual([
        { colour: 'yellow', reason: 'нема даних: дата релізу litestream' }]);
    });
    it('an unreadable source is "нема даних"', () => {
      expect(at({ litestream: { ok: false, reason: 'релізи litestream ще не завантажено' } })).toEqual([
        { colour: 'yellow', reason: 'нема даних: релізи litestream ще не завантажено' }]);
    });
    it('an installed version dpkg could not name is "нема даних"', () => {
      expect(at({}, { ...PACKAGES, litestream: null })).toEqual([
        { colour: 'yellow', reason: 'нема даних: встановлена версія litestream' }]);
    });
  });
});
