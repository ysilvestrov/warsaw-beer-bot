import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { setJobState } from '../storage/job_state';
import { saveStatusSnapshot } from '../storage/status_snapshots';
import { collectStatusInputs } from './status-inputs';
import { CANARY_STATE_KEY } from './enrich-orphans';
import { TRIAGE_LAST_RESULT_KEY, TRIAGE_LAST_RUN_KEY } from './orphan-triage';
import { UNLOCK_LAST_RESULT_KEY, UNLOCK_LAST_RUN_KEY } from './unlock-fixed-orphans';
import { BUG_REPORT_PAUSED_KEY } from './bug-report-worker';
import { FEST_MENU_LAST_KEY } from './fest-poll';
import { KEEPALIVE_LAST_KEY } from './fest-friend-feed';
import { GREEN_METRICS } from '../domain/status/test-inputs';

const NOW = new Date('2026-10-06T07:00:00.000Z');
const DATE = '2026-10-06';
// This dev host is the production host: no test may fall back to the real default paths.
const missing = {
  testDiagnosticsPath: join(tmpdir(), 'wbb-status-inputs-missing', 'summary.json'),
  hostPatchPath: join(tmpdir(), 'wbb-status-inputs-missing', 'host-patch.json'),
};

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('canary: absent → never ran; valid → value; malformed → unavailable', () => {
  const db = emptyDb();
  const absent = collectStatusInputs(db, NOW, DATE, missing).canary;
  setJobState(db, CANARY_STATE_KEY, JSON.stringify({ ok: false, at: '2026-10-06T03:30:10.000Z' }));
  const valid = collectStatusInputs(db, NOW, DATE, missing).canary;
  setJobState(db, CANARY_STATE_KEY, '{"ok":"yes"}');
  const malformed = collectStatusInputs(db, NOW, DATE, missing).canary;
  const raws = ['garbage', 'null', '{"ok":false,"at":"nope"}'];
  const broken = raws.map((raw) => {
    setJobState(db, CANARY_STATE_KEY, raw);
    return collectStatusInputs(db, NOW, DATE, missing).canary;
  });
  expect(broken).toEqual(raws.map(() => ({ ok: false, reason: 'стан канарки пошкоджено' })));
  expect([absent, valid, malformed]).toEqual([
    { ok: true, value: null },
    { ok: true, value: { ok: false, at: '2026-10-06T03:30:10.000Z' } },
    { ok: false, reason: 'стан канарки пошкоджено' },
  ]);
});

test('triage and unlock: ran today only when their run key is today; stale results are ignored', () => {
  const db = emptyDb();
  setJobState(db, TRIAGE_LAST_RUN_KEY, DATE);
  setJobState(db, TRIAGE_LAST_RESULT_KEY, JSON.stringify({ date: DATE, line: 'Тріаж: 7 рядків', saturated: 'Насичені: #452 (14) — усього 1' }));
  setJobState(db, UNLOCK_LAST_RUN_KEY, '2026-10-05');
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({ date: '2026-10-05', withheld: [{ beerId: 1, issueNumber: 2 }] }));
  const i = collectStatusInputs(db, NOW, DATE, missing);
  expect([i.triage, i.unlock]).toEqual([
    { ranToday: true, line: 'Тріаж: 7 рядків', saturated: 'Насичені: #452 (14) — усього 1' },
    { ranToday: false, withheld: [] },
  ]);
});

test('unlock result for today with an invalid row is unreadable, not zero withheld', () => {
  const db = emptyDb();
  setJobState(db, UNLOCK_LAST_RUN_KEY, DATE);
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({ date: DATE, withheld: [{ beerId: 1, issueNumber: 2 }, { beerId: -3, issueNumber: 4 }] }));
  expect(collectStatusInputs(db, NOW, DATE, missing).unlock).toEqual({ ranToday: true, withheld: null });
});

test.each([
  ['unparseable JSON', '{'],
  ['a non-object', '"x"'],
  ['a non-array withheld', JSON.stringify({ date: DATE, withheld: 'none' })],
  ['a null row', JSON.stringify({ date: DATE, withheld: [null] })],
])('unlock result for today that is %s is unreadable', (_name, raw) => {
  const db = emptyDb();
  setJobState(db, UNLOCK_LAST_RESULT_KEY, raw);
  expect(collectStatusInputs(db, NOW, DATE, missing).unlock.withheld).toBeNull();
});

test('unlock result of another date with a broken withheld is nothing to report', () => {
  const db = emptyDb();
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({ date: '2026-10-05', withheld: 'broken' }));
  expect(collectStatusInputs(db, NOW, DATE, missing).unlock.withheld).toEqual([]);
});

test('missing monitor file is unavailable disk data and null disk metrics', () => {
  const i = collectStatusInputs(emptyDb(), NOW, DATE, missing);
  expect([i.disk, i.metrics.diskBytesAvailable, i.metrics.inodesFree]).toEqual([
    { ok: false, reason: 'дані монітора недоступні' }, null, null,
  ]);
});

test('#469: a missing host summary is "підсумок патчів хоста недоступний" and upstream is "ще не завантажено"', () => {
  const inputs = collectStatusInputs(emptyDb(), NOW, DATE, missing);
  expect([inputs.hostPatch, inputs.upstream.nodeEnd]).toEqual([
    { ok: false, reason: 'підсумок патчів хоста недоступний' },
    { ok: false, reason: 'графік підтримки Node ще не завантажено' },
  ]);
});

test('#469: a valid host summary four hours old is "збирач патчів мовчить"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-status-inputs-stale-'));
  try {
    chmodSync(dir, 0o755);
    const file = join(dir, 'summary.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      timestamp: NOW.getTime() / 1000 - 4 * 3600,
      kernel: { running: '6.8.0-142-generic', newest_installed: '6.8.0-142-generic' },
      reboot_required: null,
      livepatch: { state: 'nothing-to-apply', upgrade_required_date: '2027-10-02' },
      stale_services: [],
      unattended: { last_run: null, security_pending: 0 },
      packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: null },
    }), { mode: 0o644 });
    chmodSync(file, 0o644);
    const inputs = collectStatusInputs(emptyDb(), NOW, DATE, { ...missing, hostPatchPath: file, hostPatchUid: process.getuid!() });
    expect(inputs.hostPatch).toEqual({ ok: false, reason: 'збирач патчів мовчить' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no repo → no bug-report channel; a repo → summary and paused state', () => {
  const db = emptyDb();
  const without = collectStatusInputs(db, NOW, DATE, missing).bugReports;
  const withRepo = collectStatusInputs(db, NOW, DATE, { ...missing, repo: 'o/r' }).bugReports;
  expect([without, withRepo?.paused, withRepo?.summary.processed]).toEqual([null, null, 0]);
});

test('history covers the 13 days before the report date and excludes today', () => {
  const db = emptyDb();
  for (const date of ['2026-09-22', '2026-09-23', '2026-10-05', '2026-10-06']) {
    saveStatusSnapshot(db, { date, metrics: GREEN_METRICS, colours: [], createdAt: `${date}T07:00:00.000Z` });
  }
  expect(collectStatusInputs(db, NOW, DATE, missing).history.map((s) => s.date)).toEqual(['2026-09-23', '2026-10-05']);
});

test('fest inputs are null without a current or upcoming fest', () => {
  expect(collectStatusInputs(emptyDb(), new Date('2027-06-01T07:00:00.000Z'), '2027-06-01', missing).fest).toBeNull();
});

test('persisted pause, unlock result and fest timestamps are carried through as written', () => {
  const db = emptyDb();
  setJobState(db, BUG_REPORT_PAUSED_KEY, '{"since":"2026-10-06T04:12:33.000Z","status":401}');
  setJobState(db, UNLOCK_LAST_RUN_KEY, DATE);
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({ date: DATE, withheld: [{ beerId: 38770, issueNumber: 452 }] }));
  setJobState(db, FEST_MENU_LAST_KEY, '2026-10-06T01:00:00.000Z');
  setJobState(db, KEEPALIVE_LAST_KEY, '2026-10-05T07:00:00.000Z');
  const i = collectStatusInputs(db, NOW, DATE, { ...missing, repo: 'o/r' });
  expect([i.bugReports?.paused, i.unlock, i.fest]).toEqual([
    { since: '2026-10-06T04:12:33.000Z', status: 401 },
    { ranToday: true, withheld: [{ beerId: 38770, issueNumber: 452 }] },
    { menuLastAt: '2026-10-06T01:00:00.000Z', menuCycleMs: 21_600_000,
      keepaliveLastAt: '2026-10-05T07:00:00.000Z', keepaliveCycleMs: 86_400_000 },
  ]);
});

test('canary: a timestamp more than a minute in the future is unreadable; within a minute it is kept', () => {
  const db = emptyDb();
  setJobState(db, CANARY_STATE_KEY, JSON.stringify({ ok: true, at: '2026-10-06T07:01:00.000Z' }));
  const withinSkew = collectStatusInputs(db, NOW, DATE, missing).canary;
  setJobState(db, CANARY_STATE_KEY, JSON.stringify({ ok: true, at: '2026-10-06T07:01:01.000Z' }));
  const future = collectStatusInputs(db, NOW, DATE, missing).canary;
  expect([withinSkew, future]).toEqual([
    { ok: true, value: { ok: true, at: '2026-10-06T07:01:00.000Z' } },
    { ok: false, reason: 'стан канарки пошкоджено' },
  ]);
});

test('triage that ran today: a missing, unparseable, null, wrongly typed or other-date result is unreadable', () => {
  const db = emptyDb();
  setJobState(db, TRIAGE_LAST_RUN_KEY, DATE);
  const missingResult = collectStatusInputs(db, NOW, DATE, missing).triage;
  const read = (raw: string) => { setJobState(db, TRIAGE_LAST_RESULT_KEY, raw); return collectStatusInputs(db, NOW, DATE, missing).triage; };
  const unreadable = { ranToday: true, line: null, saturated: null, unreadable: true };
  expect([
    missingResult,
    read('garbage'),
    read('null'),
    read('{}'),
    read(JSON.stringify({ date: DATE, line: 7 })),
    read(JSON.stringify({ date: DATE, line: 'Тріаж: 7 рядків', saturated: 5 })),
    read(JSON.stringify({ date: '2026-10-05', line: 'Тріаж: 3 рядки' })),
    read(JSON.stringify({ date: DATE, line: 'Тріаж: 7 рядків' })),
  ]).toEqual([
    unreadable, unreadable, unreadable, unreadable, unreadable, unreadable, unreadable,
    { ranToday: true, line: 'Тріаж: 7 рядків', saturated: null },
  ]);
});

test('triage that has not run today: an old or missing result is nothing to report', () => {
  const db = emptyDb();
  setJobState(db, TRIAGE_LAST_RUN_KEY, '2026-10-05');
  const none = collectStatusInputs(db, NOW, DATE, missing).triage;
  setJobState(db, TRIAGE_LAST_RESULT_KEY, JSON.stringify({ date: '2026-10-05', line: 'Тріаж: 3 рядки' }));
  const old = collectStatusInputs(db, NOW, DATE, missing).triage;
  expect([none, old]).toEqual([
    { ranToday: false, line: null, saturated: null },
    { ranToday: false, line: null, saturated: null },
  ]);
});

test('canary: timestamps Date.parse accepts but toISOString never writes are unreadable', () => {
  const db = emptyDb();
  setJobState(db, CANARY_STATE_KEY, JSON.stringify({ ok: true, at: '0' }));
  const zero = collectStatusInputs(db, NOW, DATE, missing).canary;
  setJobState(db, CANARY_STATE_KEY, JSON.stringify({ ok: true, at: 'Mon, 05 Oct 2026 07:00:00 GMT' }));
  const rfc = collectStatusInputs(db, NOW, DATE, missing).canary;
  expect([zero, rfc]).toEqual([
    { ok: false, reason: 'стан канарки пошкоджено' },
    { ok: false, reason: 'стан канарки пошкоджено' },
  ]);
});

test('pause marker: unparseable, wrongly typed or future-dated is unreadable; absent is not paused', () => {
  const db = emptyDb();
  const opts = { ...missing, repo: 'o/r' };
  const read = () => { const b = collectStatusInputs(db, NOW, DATE, opts).bugReports; return [b?.paused, b?.pausedUnreadable]; };
  const absent = read();
  setJobState(db, BUG_REPORT_PAUSED_KEY, 'garbage');
  const garbage = read();
  setJobState(db, BUG_REPORT_PAUSED_KEY, 'null');
  const literalNull = read();
  setJobState(db, BUG_REPORT_PAUSED_KEY, JSON.stringify({ since: 'nope', status: 401 }));
  const badSince = read();
  setJobState(db, BUG_REPORT_PAUSED_KEY, JSON.stringify({ since: '2026-10-06T04:12:33.000Z', status: '401' }));
  const badStatus = read();
  setJobState(db, BUG_REPORT_PAUSED_KEY, JSON.stringify({ since: '2027-01-01T00:00:00.000Z', status: 401 }));
  const future = read();
  expect([absent, garbage, literalNull, badSince, badStatus, future]).toEqual([
    [null, false], [null, true], [null, true], [null, true], [null, true], [null, true],
  ]);
});
