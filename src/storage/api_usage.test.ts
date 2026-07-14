import { expect, test } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { recordMatchUsage, getUsageForDate } from './api_usage';

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

test('getUsageForDate: zeros when no row exists', () => {
  expect(getUsageForDate(db(), '2026-07-14')).toEqual({
    anonRequests: 0, authedRequests: 0, beers: 0,
  });
});

test('recordMatchUsage: inserts then increments the same-day row', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 3 });
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 2 });
  recordMatchUsage(d, { date: '2026-07-14', authed: true, beers: 5 });
  expect(getUsageForDate(d, '2026-07-14')).toEqual({
    anonRequests: 2, authedRequests: 1, beers: 10,
  });
});

test('recordMatchUsage: separate dates are independent rows', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 1 });
  recordMatchUsage(d, { date: '2026-07-15', authed: true, beers: 4 });
  expect(getUsageForDate(d, '2026-07-14')).toEqual({ anonRequests: 1, authedRequests: 0, beers: 1 });
  expect(getUsageForDate(d, '2026-07-15')).toEqual({ anonRequests: 0, authedRequests: 1, beers: 4 });
});

test('recordMatchUsage: restores busy_timeout after a successful write', () => {
  const d = db();
  const before = d.pragma('busy_timeout', { simple: true });
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 1 });
  expect(d.pragma('busy_timeout', { simple: true })).toBe(before);
});

test('recordMatchUsage: restores busy_timeout even when the write throws', () => {
  const d = db();
  d.exec('DROP TABLE api_usage'); // force the INSERT to throw
  const before = d.pragma('busy_timeout', { simple: true });
  expect(() => recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 1 })).toThrow();
  expect(d.pragma('busy_timeout', { simple: true })).toBe(before);
});
