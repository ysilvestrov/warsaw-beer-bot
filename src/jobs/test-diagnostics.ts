import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';

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

// Linux operator telemetry only. Pin the opened directory while reading its
// atomically replaced file, and treat every missing/invalid input as unknown.
export function readTestDiagnostics(now: Date, path = SUMMARY_PATH, trustedUid?: number): TestDiagnostics {
  let directory: number | undefined;
  let file: number | undefined;
  try {
    const parent = dirname(resolve(path));
    if (realpathSync(parent) !== parent) return UNAVAILABLE_D;
    directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const dirInfo = fstatSync(directory);
    if ((dirInfo.mode & 0o777) !== 0o755) return UNAVAILABLE_D;
    file = openSync(`/proc/self/fd/${directory}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file);
    // The operator account is the same ysi account pinned in deploy/sudoers.d.
    // Resolve its UID through the system account database, never from the export.
    const operatorUid = trustedUid ?? Number(execFileSync('/usr/bin/id', ['-u', 'ysi'], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 64, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (!Number.isSafeInteger(operatorUid) || operatorUid < 0 || dirInfo.uid !== operatorUid) return UNAVAILABLE_D;
    if (!info.isFile() || info.uid !== dirInfo.uid || info.nlink !== 1
      || (info.mode & 0o777) !== 0o644 || info.size > MAX_BYTES) return UNAVAILABLE_D;
    const buffer = Buffer.alloc(MAX_BYTES);
    const count = readSync(file, buffer, 0, MAX_BYTES, 0);
    if (count !== info.size || fstatSync(file).size !== info.size) return UNAVAILABLE_D;
    const parsed = summarySchema.safeParse(JSON.parse(buffer.toString('utf8', 0, count)));
    if (!parsed.success) return UNAVAILABLE_D;
    const summary = parsed.data;
    const age = now.getTime() / 1000 - summary.timestamp;
    if (!Number.isFinite(age) || age < 0) return UNAVAILABLE_D;
    if (age > 900) return { kind: 'stale' };
    return {
      kind: 'ok', bytesAvailable: summary.bytes_available,
      inodesFree: summary.inodes_free, pendingRuns: summary.pending_runs,
    };
  } catch {
    return UNAVAILABLE_D;
  } finally {
    let closeFailed = false;
    for (const fd of [file, directory]) {
      if (fd !== undefined) {
        try { closeSync(fd); }
        catch { closeFailed = true; }
      }
    }
    if (closeFailed) return UNAVAILABLE_D;
  }
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
