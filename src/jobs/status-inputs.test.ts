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
const missing = { testDiagnosticsPath: join(tmpdir(), 'wbb-status-inputs-missing', 'summary.json') };

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

test('unlock withheld rows with an invalid id are dropped as a whole result', () => {
  const db = emptyDb();
  setJobState(db, UNLOCK_LAST_RUN_KEY, DATE);
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({ date: DATE, withheld: [{ beerId: 1, issueNumber: 2 }, { beerId: -3, issueNumber: 4 }] }));
  expect(collectStatusInputs(db, NOW, DATE, missing).unlock).toEqual({ ranToday: true, withheld: [] });
});

test('missing monitor file is unavailable disk data and null disk metrics', () => {
  const i = collectStatusInputs(emptyDb(), NOW, DATE, missing);
  expect([i.disk, i.metrics.diskBytesAvailable, i.metrics.inodesFree]).toEqual([
    { ok: false, reason: 'дані монітора недоступні' }, null, null,
  ]);
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
