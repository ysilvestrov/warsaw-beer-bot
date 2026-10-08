import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { readHardenedJson } from './hardened-json';

const SUMMARY_PATH = '/var/tmp/wbb-resource-monitor/summary.json';
const MAX_BYTES = 16_384;
const UNAVAILABLE = 'Тести: дані монітора недоступні';
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const summarySchema = z.object({
  version: z.literal(1), timestamp: z.number().nonnegative(),
  inodes_free: counter, bytes_available: counter,
  runs_inventory_available: z.boolean(),
  pending_runs: z.number().int().min(0).max(256).nullable(),
}).refine((value) => value.runs_inventory_available
  ? value.pending_runs !== null : value.pending_runs === null);

export type TestDiagnostics =
  | { kind: 'ok'; bytesAvailable: number; inodesFree: number; pendingRuns: number | null }
  | { kind: 'stale' }
  | { kind: 'unavailable' };
const UNAVAILABLE_D: TestDiagnostics = { kind: 'unavailable' };

function pendingWords(count: number): string {
  const tail = count % 100;
  if (tail < 11 || tail > 14) {
    if (count % 10 === 1) return 'каталог потребує';
    if (count % 10 >= 2 && count % 10 <= 4) return 'каталоги потребують';
  }
  return 'каталогів потребують';
}

// Linux operator telemetry only; the hardened read lives in ./hardened-json.
export function readTestDiagnostics(now: Date, path = SUMMARY_PATH, trustedUid?: number): TestDiagnostics {
  // The operator account is the same ysi account pinned in deploy/sudoers.d.
  // Resolve its UID through the system account database, never from the export.
  const operatorUid = (): number => trustedUid ?? Number(execFileSync('/usr/bin/id', ['-u', 'ysi'], {
    encoding: 'utf8', timeout: 1_000, maxBuffer: 64, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim());
  const parsed = summarySchema.safeParse(readHardenedJson(path, operatorUid, MAX_BYTES));
  if (!parsed.success) return UNAVAILABLE_D;
  const summary = parsed.data;
  const age = now.getTime() / 1000 - summary.timestamp;
  if (!Number.isFinite(age) || age < 0) return UNAVAILABLE_D;
  if (age > 900) return { kind: 'stale' };
  return {
    kind: 'ok', bytesAvailable: summary.bytes_available,
    inodesFree: summary.inodes_free, pendingRuns: summary.pending_runs,
  };
}

export function formatTestDiagnostics(d: TestDiagnostics): string {
  if (d.kind === 'unavailable') return UNAVAILABLE;
  if (d.kind === 'stale') return 'Тести: дані монітора застарілі';
  const inventory = d.pendingRuns === null ? 'дані каталогів недоступні'
    : `${d.pendingRuns} ${pendingWords(d.pendingRuns)} перевірки`;
  const inodes = String(d.inodesFree).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `Тести: ${inventory} · диск: ${(d.bytesAvailable / 1024 ** 3).toFixed(2)} GiB вільно · inode: ${inodes} вільно`;
}

export function readTestDiagnosticsLine(now: Date, path = SUMMARY_PATH, trustedUid?: number): string {
  return formatTestDiagnostics(readTestDiagnostics(now, path, trustedUid));
}
