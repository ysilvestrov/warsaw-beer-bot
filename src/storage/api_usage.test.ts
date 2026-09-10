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
    anonRequests: 0, authedRequests: 0, beers: 0, mcpRequests: 0, mcpBeers: 0,
  });
});

test('recordMatchUsage: inserts then increments the same-day row', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 3, channel: 'extension' });
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 2, channel: 'extension' });
  recordMatchUsage(d, { date: '2026-07-14', authed: true, beers: 5, channel: 'extension' });
  expect(getUsageForDate(d, '2026-07-14')).toEqual({
    anonRequests: 2, authedRequests: 1, beers: 10, mcpRequests: 0, mcpBeers: 0,
  });
});

test('recordMatchUsage: separate dates are independent rows', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 1, channel: 'extension' });
  recordMatchUsage(d, { date: '2026-07-15', authed: true, beers: 4, channel: 'extension' });
  expect(getUsageForDate(d, '2026-07-14')).toEqual({
    anonRequests: 1, authedRequests: 0, beers: 1, mcpRequests: 0, mcpBeers: 0,
  });
  expect(getUsageForDate(d, '2026-07-15')).toEqual({
    anonRequests: 0, authedRequests: 1, beers: 4, mcpRequests: 0, mcpBeers: 0,
  });
});

test('recordMatchUsage: restores busy_timeout after a successful write', () => {
  const d = db();
  const before = d.pragma('busy_timeout', { simple: true });
  recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 1, channel: 'extension' });
  expect(d.pragma('busy_timeout', { simple: true })).toBe(before);
});

test('recordMatchUsage: restores busy_timeout even when the write throws', () => {
  const d = db();
  d.exec('DROP TABLE api_usage'); // force the INSERT to throw
  const before = d.pragma('busy_timeout', { simple: true });
  expect(() => recordMatchUsage(d, { date: '2026-07-14', authed: false, beers: 1, channel: 'extension' })).toThrow();
  expect(d.pragma('busy_timeout', { simple: true })).toBe(before);
});

test('recordMatchUsage: an MCP call increments ONLY the MCP counters', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-09-10', authed: true, beers: 7, channel: 'mcp' });

  const usage = getUsageForDate(d, '2026-09-10');
  expect(usage.mcpRequests).toBe(1);
  expect(usage.mcpBeers).toBe(7);
  // §3.16 declares these three the EXTENSION's traffic. If MCP fed them, the daily digest
  // line would keep claiming a fact about the extension while counting agents too — and
  // nothing would reveal it, because the number would simply grow.
  expect(usage.anonRequests).toBe(0);
  expect(usage.authedRequests).toBe(0);
  expect(usage.beers).toBe(0);

  // `authed: true` above can't tell "channel is excluded from anon/authed" apart from
  // "authed happens to route to the same zero" — the mutation `anon: args.authed ? 0 : 1`
  // (dropping the `mcp ?` guard entirely) still zeroes anon here and this assertion alone
  // would not catch it. An `authed: false` MCP call closes that gap: if the channel guard
  // were ever dropped, this would fall through to the extension's anon-request branch.
  recordMatchUsage(d, { date: '2026-09-10', authed: false, beers: 1, channel: 'mcp' });
  expect(getUsageForDate(d, '2026-09-10').anonRequests).toBe(0);
});

test('recordMatchUsage: an extension call leaves the MCP counters untouched', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-09-10', authed: true, beers: 5, channel: 'extension' });

  const usage = getUsageForDate(d, '2026-09-10');
  expect(usage.authedRequests).toBe(1);
  expect(usage.beers).toBe(5);
  expect(usage.mcpRequests).toBe(0);
  expect(usage.mcpBeers).toBe(0);
});

test('recordMatchUsage: both channels accumulate side by side on one date', () => {
  const d = db();
  recordMatchUsage(d, { date: '2026-09-10', authed: false, beers: 3, channel: 'extension' });
  recordMatchUsage(d, { date: '2026-09-10', authed: true,  beers: 4, channel: 'extension' });
  recordMatchUsage(d, { date: '2026-09-10', authed: true,  beers: 9, channel: 'mcp' });

  const usage = getUsageForDate(d, '2026-09-10');
  expect(usage).toEqual({
    anonRequests: 1, authedRequests: 1, beers: 7, mcpRequests: 1, mcpBeers: 9,
  });
});
