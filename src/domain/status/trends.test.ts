import { computeTrends } from './trends';
import { DATE, GREEN_METRICS, pastDays } from './test-inputs';
import { GIB_BYTES } from './rules';
import type { SnapshotMetrics } from './types';

const today = (patch: Partial<SnapshotMetrics>) => ({ ...GREEN_METRICS, ...patch });
const weekAgo = (patch: Partial<SnapshotMetrics>) => [{ date: '2026-09-29', metrics: today(patch) }];

test('no history means no trends', () => {
  expect(computeTrends(DATE, today({ orphansPending: 9_999 }), [])).toEqual([]);
});

test('a stock line needs both +10 % and +20 units against the value a week ago', () => {
  expect([
    computeTrends(DATE, today({ orphansPending: 120 }), weekAgo({ orphansPending: 100 })),  // +20 exactly: no
    computeTrends(DATE, today({ orphansPending: 121 }), weekAgo({ orphansPending: 100 })),
    computeTrends(DATE, today({ orphansPending: 1_021 }), weekAgo({ orphansPending: 1_000 })), // +2.1 %: no
  ]).toEqual([[], ['сиріт у черзі: 100 → 121 (+21 % за тиждень)'], []]);
});

test('a falling stock reads with a minus sign and grouped thousands', () => {
  expect(computeTrends(DATE, today({ beersTotal: 26_000 }), weekAgo({ beersTotal: 30_000 })))
    .toEqual(['пив у каталозі: 30 000 → 26 000 (−13 % за тиждень)']);
});

test('disk trend is in GiB and needs a full GiB of movement', () => {
  expect([
    computeTrends(DATE, today({ diskBytesAvailable: 31 * GIB_BYTES }), weekAgo({ diskBytesAvailable: 32 * GIB_BYTES })),
    computeTrends(DATE, today({ diskBytesAvailable: 28 * GIB_BYTES }), weekAgo({ diskBytesAvailable: 32 * GIB_BYTES })),
  ]).toEqual([[], ['вільно на диску, GiB: 32.00 → 28.00 (−13 % за тиждень)']]);
});

test('a null disk value on either side skips the disk line', () => {
  expect(computeTrends(DATE, today({ diskBytesAvailable: null }), weekAgo({ diskBytesAvailable: 1 }))).toEqual([]);
});

test('flows compare two 7-day sums and need both +50 % and +10', () => {
  // previous window DATE-7..DATE-13: 7 × 2 = 14. Current window = today + DATE-1..DATE-6 at 3 each:
  // today 6 → 24 (delta 10, not > 10: silent); today 7 → 25 (delta 11 > 10 and > 7: shown).
  const history = [...pastDays(6, { extMatchRequests: 3 }), ...pastDays(13, { extMatchRequests: 2 }).slice(6)];
  expect([
    computeTrends(DATE, today({ extMatchRequests: 6 }), history),
    computeTrends(DATE, today({ extMatchRequests: 7 }), history),
  ]).toEqual([[], ['запитів розширення: 14 → 25 за 7 днів (+79 %)']]);
});

test('flows stay silent when any of the 13 previous days is missing', () => {
  const history = [...pastDays(6, { extMatchRequests: 30 }), ...pastDays(12, { extMatchRequests: 0 }).slice(6)];
  expect(computeTrends(DATE, today({ extMatchRequests: 30 }), history)).toEqual([]);
});

test('a flow growing from zero reads as new', () => {
  const history = [...pastDays(6, { mcpMatchRequests: 2 }), ...pastDays(13, { mcpMatchRequests: 0 }).slice(6)];
  expect(computeTrends(DATE, today({ mcpMatchRequests: 2 }), history)).toEqual(['запитів MCP: 0 → 14 за 7 днів (нове)']);
});
