import type { SnapshotRecord } from './types';
import { GIB_BYTES } from './rules';

// 'YYYY-MM-DD' moved by `days` calendar days. UTC math on a date-only value: DST never applies.
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function snapshotOn(history: SnapshotRecord[], date: string): SnapshotRecord | null {
  return history.find((s) => s.date === date) ?? null;
}

// Snapshots of the n days before `date`, newest first — or null when any of them is missing, so a
// comparison rule never runs on a partial week.
export function previousDays(history: SnapshotRecord[], date: string, n: number): SnapshotRecord[] | null {
  const days = Array.from({ length: n }, (_, k) => snapshotOn(history, shiftDate(date, -(k + 1))));
  return days.every((s): s is SnapshotRecord => s !== null) ? days : null;
}

// Milliseconds of an ISO-8601 UTC instant as `Date.toISOString()` writes it, or NaN for anything
// else. Date.parse alone accepts strings like "0" as dates, which would let corrupt state read healthy.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export function parseIsoInstant(value: string): number {
  return ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function warsawClock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

export function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function gib(bytes: number): string {
  return (bytes / GIB_BYTES).toFixed(2);
}
