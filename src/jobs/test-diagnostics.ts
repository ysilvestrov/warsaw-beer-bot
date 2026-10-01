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
export function readTestDiagnosticsLine(now: Date, path = SUMMARY_PATH, trustedUid?: number): string {
  let directory: number | undefined;
  let file: number | undefined;
  try {
    const parent = dirname(resolve(path));
    if (realpathSync(parent) !== parent) return UNAVAILABLE;
    directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const dirInfo = fstatSync(directory);
    if ((dirInfo.mode & 0o777) !== 0o755) return UNAVAILABLE;
    file = openSync(`/proc/self/fd/${directory}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file);
    // The operator account is the same ysi account pinned in deploy/sudoers.d.
    // Resolve its UID through the system account database, never from the export.
    const operatorUid = trustedUid ?? Number(execFileSync('/usr/bin/id', ['-u', 'ysi'], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 64, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (!Number.isSafeInteger(operatorUid) || operatorUid < 0 || dirInfo.uid !== operatorUid) return UNAVAILABLE;
    if (!info.isFile() || info.uid !== dirInfo.uid || info.nlink !== 1
      || (info.mode & 0o777) !== 0o644 || info.size > MAX_BYTES) return UNAVAILABLE;
    const buffer = Buffer.alloc(MAX_BYTES);
    const count = readSync(file, buffer, 0, MAX_BYTES, 0);
    if (count !== info.size || fstatSync(file).size !== info.size) return UNAVAILABLE;
    const parsed = summarySchema.safeParse(JSON.parse(buffer.toString('utf8', 0, count)));
    if (!parsed.success) return UNAVAILABLE;
    const summary = parsed.data;
    const age = now.getTime() / 1000 - summary.timestamp;
    if (!Number.isFinite(age) || age < 0) return UNAVAILABLE;
    if (age > 900) return 'Тести: дані монітора застарілі';
    const inventory = summary.pending_runs === null ? 'дані каталогів недоступні'
      : `${summary.pending_runs} ${pendingWords(summary.pending_runs)} перевірки`;
    const inodes = String(summary.inodes_free).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `Тести: ${inventory} · диск: ${(summary.bytes_available / 1024 ** 3).toFixed(2)} GiB вільно · inode: ${inodes} вільно`;
  } catch {
    return UNAVAILABLE;
  } finally {
    let closeFailed = false;
    for (const fd of [file, directory]) {
      if (fd !== undefined) {
        try { closeSync(fd); }
        catch { closeFailed = true; }
      }
    }
    if (closeFailed) return UNAVAILABLE;
  }
}
