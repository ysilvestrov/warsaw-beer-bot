import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { getJobState, setJobState } from '../storage/job_state';
import { REBOOT_ALERT_KEY, rebootAlert, snoozeRebootAlertNow } from './reboot-alert';

/** #469 stage 3. The summary is written to a temp dir; no test reads the real host path. */
const log = pino({ level: 'silent' });
const DAY = 86_400;
const T = 1_791_461_800;
const NOW = new Date(T * 1000);
const SINCE = T - 4 * DAY;
let db: DB;
let dir: string;
let path: string;

function summary(rebootRequired: { since: number; packages: string[] } | null, at = T) {
  writeFileSync(path, JSON.stringify({
    version: 1, timestamp: at - 600,
    kernel: { running: '6.8.0-142-generic', newest_installed: '6.8.0-142-generic' },
    reboot_required: rebootRequired,
    livepatch: { state: 'nothing-to-apply', upgrade_required_date: '2027-10-02' },
    stale_services: [], unattended: { last_run: at - 3600, security_pending: 0 },
    packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.17' },
  }), { mode: 0o644 });
  chmodSync(path, 0o644);
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  dir = mkdtempSync(join(tmpdir(), 'wbb-reboot-alert-'));
  chmodSync(dir, 0o755);
  path = join(dir, 'summary.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(sent: string[], opts: { now?: Date; fail?: boolean } = {}) {
  return rebootAlert({
    db, log, now: () => opts.now ?? NOW, hostPatchPath: path, hostPatchUid: process.getuid!(),
    send: async (text) => { if (opts.fail) throw new Error('telegram down'); sent.push(text); },
  });
}

describe('rebootAlert', () => {
  it('alerts a pending reboot once across two ticks', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    const sent: string[] = [];
    await run(sent);
    await run(sent);
    expect(sent).toEqual(['🔁 Хосту потрібне перезавантаження — чекає 4 дні: libc6.\nLivepatch: nothing-to-apply.']);
  });

  it('a failed send saves nothing, so the next tick retries', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    await expect(run([], { fail: true })).rejects.toThrow('telegram down');
    const sent: string[] = [];
    await run(sent);
    expect([getJobState(db, REBOOT_ALERT_KEY), sent.length]).toEqual([JSON.stringify({ since: SINCE, snoozeUntil: null }), 1]);
  });

  it('a snooze silences the reboot for 3 days, then it is alerted again', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    await run([]);
    expect(snoozeRebootAlertNow(db, SINCE, NOW)).toBe(true);
    const quiet: string[] = [];
    summary({ since: SINCE, packages: ['libc6'] }, T + 3 * DAY - 1); // fresh summary, or the read is stale
    await run(quiet, { now: new Date((T + 3 * DAY - 1) * 1000) });
    const again: string[] = [];
    summary({ since: SINCE, packages: ['libc6'] }, T + 3 * DAY);
    await run(again, { now: new Date((T + 3 * DAY) * 1000) });
    expect([quiet.length, again.length]).toEqual([0, 1]);
  });

  it('nothing to snooze when no alert is pending', () => {
    expect(snoozeRebootAlertNow(db, SINCE, NOW)).toBe(false);
  });

  it('a snooze bound to a different since is refused and leaves the state as it was', () => {
    const stored = JSON.stringify({ since: SINCE, snoozeUntil: null });
    setJobState(db, REBOOT_ALERT_KEY, stored);
    expect(snoozeRebootAlertNow(db, SINCE - DAY, NOW)).toBe(false);
    expect(getJobState(db, REBOOT_ALERT_KEY)).toBe(stored);
  });

  it('a snooze bound to the alerted since stores the snooze', () => {
    setJobState(db, REBOOT_ALERT_KEY, JSON.stringify({ since: SINCE, snoozeUntil: null }));
    expect(snoozeRebootAlertNow(db, SINCE, NOW)).toBe(true);
    expect(getJobState(db, REBOOT_ALERT_KEY)).toBe(JSON.stringify({ since: SINCE, snoozeUntil: T + 3 * DAY }));
  });

  it('clears its state when no reboot is pending', async () => {
    setJobState(db, REBOOT_ALERT_KEY, JSON.stringify({ since: SINCE, snoozeUntil: null }));
    summary(null);
    await run([]);
    expect(getJobState(db, REBOOT_ALERT_KEY)).toBe(null);
  });

  it('a corrupt stored state reads as no state: the reboot is alerted', async () => {
    setJobState(db, REBOOT_ALERT_KEY, '{');
    summary({ since: SINCE, packages: [] });
    const sent: string[] = [];
    await run(sent);
    expect(sent.length).toBe(1);
  });
});
