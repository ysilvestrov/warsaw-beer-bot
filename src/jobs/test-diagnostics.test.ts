import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readTestDiagnosticsLine as readWithOwner } from './test-diagnostics';

// Controlled export fixtures belong to the test runner's actual OS account.
const readTestDiagnosticsLine = (now: Date, path: string): string =>
  readWithOwner(now, path, process.getuid!());

let directory: string;
let path: string;
const now = new Date(1_200_000);
const snapshot = {
  version: 1, timestamp: 1_200, inodes_free: 2_000_000, bytes_available: 32_212_254_720,
  runs_inventory_available: true, pending_runs: 1,
};
const unavailable = 'Тести: дані монітора недоступні';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wbb-diagnostics-reader-'));
  chmodSync(directory, 0o755);
  path = join(directory, 'summary.json');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function write(value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o644 });
  chmodSync(path, 0o644);
}

// Wrong count or plural branch changes the administrator's view of the inventory.
test.each([
  [0, '0 каталогів потребують перевірки'],
  [1, '1 каталог потребує перевірки'],
  [2, '2 каталоги потребують перевірки'],
  [4, '4 каталоги потребують перевірки'],
  [5, '5 каталогів потребують перевірки'],
  [11, '11 каталогів потребують перевірки'],
  [21, '21 каталог потребує перевірки'],
  [22, '22 каталоги потребують перевірки'],
])('shows the exact inventory for %i pending directories', (count, words) => {
  write({ ...snapshot, pending_runs: count });
  expect(readTestDiagnosticsLine(now, path)).toBe(
    `Тести: ${words} · диск: 30.00 GiB вільно · inode: 2 000 000 вільно`,
  );
});

test('unavailable inventory retains measured resource counters without a false zero', () => {
  write({ ...snapshot, runs_inventory_available: false, pending_runs: null });
  expect(readTestDiagnosticsLine(now, path)).toBe(
    'Тести: дані каталогів недоступні · диск: 30.00 GiB вільно · inode: 2 000 000 вільно',
  );
});

test('accepts a snapshot exactly fifteen minutes old', () => {
  write({ ...snapshot, timestamp: 300 });
  expect(readTestDiagnosticsLine(now, path)).toBe(
    'Тести: 1 каталог потребує перевірки · диск: 30.00 GiB вільно · inode: 2 000 000 вільно',
  );
});

test('does not claim current counts from a snapshot over fifteen minutes old', () => {
  write({ ...snapshot, timestamp: 299 });
  expect(readTestDiagnosticsLine(now, path)).toBe('Тести: дані монітора застарілі');
});

test.each([
  { timestamp: 1_201 }, { timestamp: -1 }, { timestamp: '1200' },
  { version: 2 }, { version: true }, { inodes_free: -1 }, { inodes_free: 0.5 },
  { inodes_free: Number.MAX_SAFE_INTEGER + 1 }, { bytes_available: -1 },
  { pending_runs: -1 }, { pending_runs: 1.5 }, { pending_runs: 257 },
  { pending_runs: null }, { runs_inventory_available: false },
  { runs_inventory_available: 'true' },
])('refuses invalid snapshot fields %j', (changes) => {
  write({ ...snapshot, ...changes });
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test.each(['{', 'null', '[]', '"text"', '{"timestamp":NaN}'])('invalid JSON shape %s cannot break the report', (raw) => {
  writeFileSync(path, raw, { mode: 0o644 });
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test('missing snapshot returns unavailable', () => {
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test.each([0o600, 0o666])('refuses wrong snapshot permissions %i', (mode) => {
  write(snapshot);
  chmodSync(path, mode);
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test.each([0o777, 0o700, 0o750])('refuses wrong directory permissions %i', (mode) => {
  write(snapshot);
  chmodSync(directory, mode);
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test('refuses inconsistent directory and file owners', () => {
  write(snapshot);
  const directoryInfo = fs.statSync(directory);
  const fileInfo = fs.statSync(path);
  // Creating a foreign-owned fixture requires root. Preserve real filesystem
  // operations and change only the UID reported at the OS stat boundary.
  const foreignInfo = Object.assign(Object.create(fileInfo) as fs.Stats, { uid: directoryInfo.uid + 1 });
  const spy = vi.spyOn(fs, 'fstatSync')
    .mockReturnValueOnce(directoryInfo).mockReturnValueOnce(foreignInfo);
  syncBuiltinESMExports();
  try {
    expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test('refuses a matching directory and file owner that is not the trusted operator', () => {
  write(snapshot);
  expect(readWithOwner(now, path, process.getuid!() + 1)).toBe(unavailable);
});

test('default trust comes from the configured operator account rather than the snapshot', () => {
  write(snapshot);
  const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
    expect(command).toBe('/usr/bin/id');
    expect(args).toEqual(['-u', 'ysi']);
    return String(process.getuid!()) + '\n';
  });
  syncBuiltinESMExports();
  try {
    expect(readWithOwner(now, path)).toBe(
      'Тести: 1 каталог потребує перевірки · диск: 30.00 GiB вільно · inode: 2 000 000 вільно',
    );
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test('an unavailable operator account returns unknown instead of trusting the export owner', () => {
  write(snapshot);
  const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
    throw new Error('synthetic account lookup failure');
  });
  syncBuiltinESMExports();
  try {
    expect(readWithOwner(now, path)).toBe(unavailable);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a file-close failure returns unknown and still closes the directory', () => {
  write(snapshot);
  const originalClose = fs.closeSync;
  const closed: number[] = [];
  const spy = vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
    closed.push(fd);
    originalClose(fd);
    throw new Error('synthetic close I/O error');
  }).mockImplementationOnce((fd) => {
    closed.push(fd);
    originalClose(fd);
  });
  syncBuiltinESMExports();
  try {
    expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
    expect(closed.length).toBe(2);
    expect(() => fs.fstatSync(closed[0])).toThrow(/EBADF/);
    expect(() => fs.fstatSync(closed[1])).toThrow(/EBADF/);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a directory-close failure cannot escape into the morning job', () => {
  write(snapshot);
  const originalClose = fs.closeSync;
  const closed: number[] = [];
  const spy = vi.spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
    closed.push(fd);
    originalClose(fd);
  }).mockImplementationOnce((fd) => {
    closed.push(fd);
    originalClose(fd);
    throw new Error('synthetic close I/O error');
  });
  syncBuiltinESMExports();
  try {
    expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
    expect(closed.length).toBe(2);
    expect(() => fs.fstatSync(closed[0])).toThrow(/EBADF/);
    expect(() => fs.fstatSync(closed[1])).toThrow(/EBADF/);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test('refuses a symlink snapshot', () => {
  const target = join(directory, 'target.json');
  writeFileSync(target, JSON.stringify(snapshot), { mode: 0o644 });
  symlinkSync(target, path);
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test('refuses a symlink export directory', () => {
  const target = join(directory, 'real');
  mkdirSync(target, { mode: 0o755 });
  writeFileSync(join(target, 'summary.json'), JSON.stringify(snapshot), { mode: 0o644 });
  const link = join(directory, 'linked');
  symlinkSync(target, link);
  expect(readTestDiagnosticsLine(now, join(link, 'summary.json'))).toBe(unavailable);
});

test('refuses a multiply linked file', () => {
  write(snapshot);
  linkSync(path, join(directory, 'other-link'));
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test('refuses a directory in place of the snapshot file', () => {
  mkdirSync(path, { mode: 0o644 });
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test('refuses a FIFO without blocking the morning report', () => {
  const result = spawnSync('mkfifo', ['-m', '644', path], { encoding: 'utf8', timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test('rejects an oversized valid JSON file before reading it', () => {
  writeFileSync(path, JSON.stringify(snapshot) + ' '.repeat(16_384), { mode: 0o644 });
  expect(readTestDiagnosticsLine(now, path)).toBe(unavailable);
});

test('accepts valid JSON at the exact size boundary', () => {
  const raw = JSON.stringify(snapshot);
  writeFileSync(path, raw.padEnd(16_384, ' '), { mode: 0o644 });
  expect(readTestDiagnosticsLine(now, path)).toBe(
    'Тести: 1 каталог потребує перевірки · диск: 30.00 GiB вільно · inode: 2 000 000 вільно',
  );
});

test('reads the actual Python export through the TypeScript contract', () => {
  const result = spawnSync('python3', ['-B', '-c',
    "import sys; from pathlib import Path; from resource_monitor import publish_summary; " +
    "publish_summary(Path(sys.argv[1]), {'timestamp': 1200, 'device': 1, 'inodes_total': 5000000, " +
    "'inodes_free': 2000000, 'bytes_total': 80530636800, 'bytes_available': 32212254720}, " +
    "[{'name': 'run-a', 'status': 'uncertain_current_boot'}])", directory],
  { cwd: resolve(__dirname, '../../scripts/ops'), encoding: 'utf8', timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(readTestDiagnosticsLine(now, path)).toBe(
    'Тести: 1 каталог потребує перевірки · диск: 30.00 GiB вільно · inode: 2 000 000 вільно',
  );
});
