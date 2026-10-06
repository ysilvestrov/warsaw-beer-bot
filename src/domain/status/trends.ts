import type { SnapshotMetrics, SnapshotRecord } from './types';
import { STATUS_RULES as R } from './rules';
import { gib, groupThousands, previousDays, shiftDate, snapshotOn } from './helpers';

interface Series {
  label: string;
  read: (m: SnapshotMetrics) => number | null;
  abs: number;
  format: (n: number) => string;
}

// Stocks accumulate: compare today with the snapshot exactly a week ago.
const STOCKS: Series[] = [
  { label: 'сиріт у черзі', read: (m) => m.orphansPending, abs: R.stockAbs, format: groupThousands },
  { label: 'у relay-черзі', read: (m) => m.orphansRelayQueue, abs: R.stockAbs, format: groupThousands },
  { label: 'зматчених без рейтингу', read: (m) => m.ratingsMissing, abs: R.stockAbs, format: groupThousands },
  { label: 'рядків під замком', read: (m) => m.lockedRows, abs: R.stockAbs, format: groupThousands },
  { label: 'пив у каталозі', read: (m) => m.beersTotal, abs: R.stockAbs, format: groupThousands },
  { label: 'вільно на диску, GiB', read: (m) => m.diskBytesAvailable, abs: R.diskTrendAbsBytes, format: gib },
];

// Flows are per-day counts that swing 4–73 day to day (probe 2026-10-06): compare two 7-day sums.
const FLOWS: Series[] = [
  { label: 'запитів розширення', read: (m) => m.extMatchRequests, abs: R.flowAbs, format: groupThousands },
  { label: 'запитів MCP', read: (m) => m.mcpMatchRequests, abs: R.flowAbs, format: groupThousands },
  { label: 'зматчено enrich', read: (m) => m.enrichMatched24h, abs: R.flowAbs, format: groupThousands },
  { label: 'провалів enrich', read: (m) => m.enrichFailures24h, abs: R.flowAbs, format: groupThousands },
  { label: 'нових на кранах', read: (m) => m.newOnTap24h, abs: R.flowAbs, format: groupThousands },
];

function moved(from: number, to: number, rel: number, abs: number): boolean {
  const delta = Math.abs(to - from);
  return delta > abs && delta > Math.abs(from) * rel;
}

function change(from: number, to: number): string {
  if (from === 0) return 'нове';
  return `${to > from ? '+' : '−'}${Math.round((Math.abs(to - from) / from) * 100)} %`;
}

export function computeTrends(dateKey: string, today: SnapshotMetrics, history: SnapshotRecord[]): string[] {
  const lines: string[] = [];
  const weekAgo = snapshotOn(history, shiftDate(dateKey, -R.historyDays));
  if (weekAgo !== null) {
    for (const s of STOCKS) {
      const from = s.read(weekAgo.metrics);
      const to = s.read(today);
      if (from === null || to === null || !moved(from, to, R.stockRel, s.abs)) continue;
      lines.push(`${s.label}: ${s.format(from)} → ${s.format(to)} (${change(from, to)} за тиждень)`);
    }
  }
  const recent = previousDays(history, dateKey, R.historyDays - 1);                          // d-1 .. d-6
  const earlier = previousDays(history, shiftDate(dateKey, -(R.historyDays - 1)), R.historyDays); // d-7 .. d-13
  if (recent !== null && earlier !== null) {
    for (const s of FLOWS) {
      const sum = (ms: SnapshotMetrics[]) => ms.reduce((acc, m) => acc + (s.read(m) ?? 0), 0);
      const to = sum([today, ...recent.map((r) => r.metrics)]);
      const from = sum(earlier.map((r) => r.metrics));
      if (!moved(from, to, R.flowRel, s.abs)) continue;
      lines.push(`${s.label}: ${s.format(from)} → ${s.format(to)} за 7 днів (${change(from, to)})`);
    }
  }
  return lines;
}
