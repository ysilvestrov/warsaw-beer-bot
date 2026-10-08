import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRebootRequest } from './reboot-request';

/** #469 stage 3 — the bot asks; root (scripts/ops/reboot_request.py) decides. */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wbb-reboot-request-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const NOW = new Date(1_791_461_800_000);

describe('writeRebootRequest', () => {
  it.each(['now', '0400'] as const)('writes "%s <unix>" with a newline, mode 0600', (kind) => {
    writeRebootRequest(kind, NOW, dir);
    const file = join(dir, 'reboot-request');
    expect([readFileSync(file, 'utf8'), statSync(file).mode & 0o777]).toEqual([`${kind} 1791461800\n`, 0o600]);
  });

  it('leaves no temp file behind', () => {
    writeRebootRequest('now', NOW, dir);
    expect(readdirSync(dir)).toEqual(['reboot-request']);
  });

  it('replaces a request already waiting', () => {
    writeFileSync(join(dir, 'reboot-request'), 'now 1\n');
    writeRebootRequest('0400', NOW, dir);
    expect(readFileSync(join(dir, 'reboot-request'), 'utf8')).toBe('0400 1791461800\n');
  });

  it('throws when the directory does not exist (the caller tells the admin)', () => {
    expect(() => writeRebootRequest('now', NOW, join(dir, 'missing'))).toThrow();
  });
});
