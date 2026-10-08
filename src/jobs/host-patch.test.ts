import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHostPatch } from './host-patch';

/** #469 stage 2 — the summary written by scripts/ops/host_patch_collect.py. */
let directory: string;
let path: string;
const owner = (): number => process.getuid!();
const now = new Date(1_791_440_000_000);

const summary = {
  version: 1,
  timestamp: 1_791_439_000,
  kernel: { running: '6.8.0-142-generic', newest_installed: '6.8.0-145-generic' },
  reboot_required: { since: 1_790_500_000, packages: ['linux-image-6.8.0-145-generic', 'libc6'] },
  livepatch: { state: 'nothing-to-apply', upgrade_required_date: '2027-10-02' },
  stale_services: [{ unit: 'litestream.service', since: 1_791_000_000 }],
  unattended: { last_run: 1_791_439_429, security_pending: 2 },
  packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: null },
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wbb-host-patch-reader-'));
  chmodSync(directory, 0o755);
  path = join(directory, 'summary.json');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function write(value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o644 });
  chmodSync(path, 0o644);
}

describe('readHostPatch', () => {
  it('maps every field of a fresh summary', () => {
    write(summary);
    expect(readHostPatch(now, path, owner())).toEqual({
      kind: 'ok',
      facts: {
        timestamp: 1_791_439_000,
        kernel: { running: '6.8.0-142-generic', newestInstalled: '6.8.0-145-generic' },
        rebootRequired: { since: 1_790_500_000, packages: ['linux-image-6.8.0-145-generic', 'libc6'] },
        livepatch: { state: 'nothing-to-apply', upgradeRequiredDate: '2027-10-02' },
        staleServices: [{ unit: 'litestream.service', since: 1_791_000_000 }],
        unattended: { lastRun: 1_791_439_429, securityPending: 2 },
        packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: null },
      },
    });
  });

  it('keeps every nullable fact null', () => {
    write({
      ...summary, kernel: null, reboot_required: null, livepatch: null, stale_services: null,
      unattended: { last_run: null, security_pending: null },
    });
    expect(readHostPatch(now, path, owner())).toEqual({
      kind: 'ok',
      facts: {
        timestamp: 1_791_439_000, kernel: null, rebootRequired: null, livepatch: null, staleServices: null,
        unattended: { lastRun: null, securityPending: null },
        packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: null },
      },
    });
  });

  it('keeps an odd Livepatch date so the rules can call it "нема даних"', () => {
    write({ ...summary, livepatch: { state: 'applied', upgrade_required_date: '02.10.2027' } });
    expect(readHostPatch(now, path, owner())).toMatchObject({
      kind: 'ok', facts: { livepatch: { state: 'applied', upgradeRequiredDate: '02.10.2027' } } });
  });

  it('accepts a summary exactly three hours old and calls one second older stale', () => {
    write({ ...summary, timestamp: 1_791_440_000 - 10_800 });
    expect(readHostPatch(now, path, owner()).kind).toBe('ok');
    write({ ...summary, timestamp: 1_791_440_000 - 10_801 });
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'stale' });
  });

  it('refuses a summary from the future', () => {
    write({ ...summary, timestamp: 1_791_440_001 });
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['version 2', { version: 2 }],
    ['fractional timestamp', { timestamp: 1.5 }],
    ['unknown livepatch state', { livepatch: { state: 'disabled', upgrade_required_date: null } }],
    ['negative security count', { unattended: { last_run: null, security_pending: -1 } }],
    ['string since', { stale_services: [{ unit: 'ssh.service', since: '1' }] }],
    ['extra top-level key', { surprise: true }],
    ['missing packages', { packages: undefined }],
    ['empty unit name', { stale_services: [{ unit: '', since: 1 }] }],
  ])('refuses a summary with %s', (_what, patch) => {
    write({ ...summary, ...patch });
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it('is unavailable when the file is missing', () => {
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it('trusts only root by default — a summary owned by the test user is refused', () => {
    write(summary);
    expect(readHostPatch(now, path)).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['a 0600 file', () => chmodSync(path, 0o600)],
    ['a 0777 directory', () => chmodSync(directory, 0o777)],
    ['a hard-linked file', () => linkSync(path, join(directory, 'second'))],
  ])('refuses %s', (_what, spoil) => {
    write(summary);
    spoil();
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it('refuses a symlinked summary', () => {
    const real = join(directory, 'real.json');
    writeFileSync(real, JSON.stringify(summary), { mode: 0o644 });
    chmodSync(real, 0o644);
    symlinkSync(real, path);
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });

  it('refuses a summary over 16 KiB', () => {
    write({ ...summary, stale_services: Array.from({ length: 200 }, (_, k) => ({ unit: `u${k}`.padEnd(90, 'x'), since: 1 })) });
    expect(readHostPatch(now, path, owner())).toEqual({ kind: 'unavailable' });
  });
});
