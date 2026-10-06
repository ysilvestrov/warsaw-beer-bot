import pino from 'pino';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BugReportSummary } from '../domain/bug-report-types';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { buildBugReportLine, dailyStatus, shouldSendDailyStatus, EVENTS_FOOTER } from './daily-status';
import { getJobState, setJobState } from '../storage/job_state';
import { insertReport, markDone } from '../storage/bug_reports';
import { recordMatchUsage } from '../storage/api_usage';
import { saveStatusSnapshot } from '../storage/status_snapshots';
import { GREEN_METRICS } from '../domain/status/test-inputs';
import { TRIAGE_LAST_RESULT_KEY } from './orphan-triage';

const silentLog = pino({ level: 'silent' });

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const emptyReportSummary: BugReportSummary = {
  processed: 0, byVerdict: { new: 0, duplicate_open: 0, duplicate_closed: 0, not_a_bug: 0 },
  queued: 0, needsReview: [], failed: [], closedLinks: [],
};

test('buildBugReportLine omits a completely idle report pipeline', () => {
  expect(buildBugReportLine(emptyReportSummary, null, 'ysilvestrov/warsaw-beer-bot')).toBeNull();
});

test('buildBugReportLine shows queued reports even when none was processed', () => {
  expect(buildBugReportLine({ ...emptyReportSummary, queued: 2 }, null,
    'ysilvestrov/warsaw-beer-bot')).toBe(
    'скарги за добу: оброблено 0 (нових 0, відкритих дублікатів 0, закритих дублікатів 0, не-баг 0), у черзі 2, потребують перевірки 0, збоїв 0',
  );
});

test('buildBugReportLine lists every closed duplicate and every review ID', () => {
  const summary: BugReportSummary = {
    processed: 7, byVerdict: { new: 1, duplicate_open: 2, duplicate_closed: 2, not_a_bug: 1 },
    queued: 3, needsReview: [8, 10], failed: [9],
    closedLinks: [{ reportId: 4, issueNumber: 77 }, { reportId: 5, issueNumber: 78 }],
  };
  expect(buildBugReportLine(summary, null, 'ysilvestrov/warsaw-beer-bot')).toBe([
    'скарги за добу: оброблено 7 (нових 1, відкритих дублікатів 2, закритих дублікатів 2, не-баг 1), у черзі 3, потребують перевірки 2, збоїв 1',
    '  R-4 → https://github.com/ysilvestrov/warsaw-beer-bot/issues/77',
    '  R-5 → https://github.com/ysilvestrov/warsaw-beer-bot/issues/78',
    '  перевірити: R-8, R-10, R-9',
  ].join('\n'));
});

test('buildBugReportLine puts a paused warning first even with zero activity', () => {
  expect(buildBugReportLine(emptyReportSummary,
    { since: '2026-09-27T12:34:00.000Z', status: 402 },
    'ysilvestrov/warsaw-beer-bot')).toBe([
    '⚠️ скарги на паузі з 2026-09-27 12:34 UTC: ключ відхилено (402)',
    'скарги за добу: оброблено 0 (нових 0, відкритих дублікатів 0, закритих дублікатів 0, не-баг 0), у черзі 0, потребують перевірки 0, збоїв 0',
  ].join('\n'));
});

test('dailyStatus: no-op when notifyAdmin is undefined', async () => {
  const db = emptyDb();
  await expect(
    dailyStatus({ db, log: silentLog, now: () => new Date('2026-06-04T07:00:00Z') }),
  ).resolves.toBeUndefined();
});

test('dailyStatus: sends once in window and records the Warsaw date', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({
    db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-21T07:00:00Z'), // 09:00 Warsaw
  });
  expect(sent.length).toBe(1);
  expect(getJobState(db, 'daily_status_last_sent')).toBe('2026-06-21');
});

test('dailyStatus: no-op outside the window', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({
    db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-21T11:00:00Z'), // 13:00 Warsaw
  });
  expect(sent.length).toBe(0);
  expect(getJobState(db, 'daily_status_last_sent')).toBeNull();
});

test('dailyStatus: no-op when already sent today (idempotent across ticks)', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const deps = {
    db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-21T07:00:00Z'),
  };
  await dailyStatus(deps);
  await dailyStatus(deps); // second tick same morning
  expect(sent.length).toBe(1);
});

test('dailyStatus: does NOT record the date when send fails (retried next tick)', async () => {
  const db = emptyDb();
  let calls = 0;
  const deps = {
    db, log: silentLog,
    notifyAdmin: async () => { calls += 1; throw new Error('telegram down'); },
    now: () => new Date('2026-06-21T07:00:00Z'),
  };
  await dailyStatus(deps);
  expect(getJobState(db, 'daily_status_last_sent')).toBeNull();
  await dailyStatus(deps); // retry: should attempt again, not be blocked
  expect(calls).toBe(2);
});

// June = CEST (UTC+2): 07:00Z = 09:00 Warsaw. January = CET (UTC+1): 08:00Z = 09:00 Warsaw.
test('shouldSendDailyStatus: before window (08:59 Warsaw) → no send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T06:59:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: false, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: window open (09:00 Warsaw), not yet sent → send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T07:00:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: true, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: late in window (11:59 Warsaw) → send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T09:59:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: true, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: window closed (12:00 Warsaw) → no send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T10:00:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: false, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: in window but already sent today → no send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T07:00:00Z'), lastSentDate: '2026-06-21' });
  expect(r).toEqual({ send: false, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: in window, last sent yesterday → send', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-06-21T07:00:00Z'), lastSentDate: '2026-06-20' });
  expect(r).toEqual({ send: true, dateKey: '2026-06-21' });
});

test('shouldSendDailyStatus: winter CET, 09:00 Warsaw = 08:00Z → send with correct date', () => {
  const r = shouldSendDailyStatus({ now: new Date('2026-01-15T08:00:00Z'), lastSentDate: null });
  expect(r).toEqual({ send: true, dateKey: '2026-01-15' });
});

test('dailyStatus: picks up today\'s triage result from job_state', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-07-05T07:30:00Z'); // 09:30 Warsaw
  setJobState(db, TRIAGE_LAST_RESULT_KEY,
    JSON.stringify({ date: '2026-07-05', line: 'Тріаж: 1 нових' }));
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (m) => { sent.push(m); }, now });
  expect(sent[0]).toContain('• Тріаж: 1 нових');
});

test('dailyStatus: stale (yesterday) triage result is ignored', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-07-05T07:30:00Z');
  setJobState(db, TRIAGE_LAST_RESULT_KEY,
    JSON.stringify({ date: '2026-07-04', line: 'Тріаж: 9 нових' }));
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (m) => { sent.push(m); }, now });
  expect(sent[0]).not.toContain('Тріаж');
});

// Forward compatibility is not theoretical here: the payload written by the run on the
// morning of the deploy has no `saturated` key, and the digest reads it that same day.
test('#431: a payload written before this change reads as no saturated line', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-07-05T07:30:00Z');
  setJobState(db, TRIAGE_LAST_RESULT_KEY,
    JSON.stringify({ date: '2026-07-05', line: 'Тріаж: 50 нових' }));
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (m) => { sent.push(m); }, now });
  expect(sent[0]).toContain('• Тріаж: 50 нових');
  expect(sent[0]).not.toContain('Насичені');
});

const missingMonitor = { testDiagnosticsPath: join(tmpdir(), 'wbb-daily-missing', 'summary.json') };

test('dailyStatus sends the traffic light and writes today\'s snapshot first', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async (t) => { sent.push(t); } });
  expect([
    sent.length,
    sent[0].split('\n')[0],
    sent[0].includes(`ℹ️ ${EVENTS_FOOTER}`),
    sent[0].split('\n').includes('ℹ️ не виміряно: помилки /match і MCP, стан деплою, GitHub — ще не підключені (етап 2)'),
    sent[0].includes('  • скрейпів кранів немає взагалі'),
    db.prepare('SELECT date FROM status_snapshots').all(),
    getJobState(db, 'daily_status_last_sent'),
  ]).toEqual([1, '🔴 Статус бота — 2026-10-06 09:00 · потрібна реакція', true, true, true, [{ date: '2026-10-06' }], '2026-10-06']);
});

test('a failed send keeps the snapshot and leaves the day open for the next tick', async () => {
  const db = emptyDb();
  await dailyStatus({ db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async () => { throw new Error('synthetic transport unavailable'); } });
  expect([db.prepare('SELECT date FROM status_snapshots').all(), getJobState(db, 'daily_status_last_sent')])
    .toEqual([[{ date: '2026-10-06' }], null]);
});

test('a report that cannot be assembled sends one 🔴 fallback per day and never marks delivery', async () => {
  const db = emptyDb();
  db.exec('DROP TABLE status_snapshots');
  const sent: string[] = [];
  const deps = { db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async (t: string) => { sent.push(t); } };
  await dailyStatus(deps);
  await dailyStatus(deps);
  expect([sent.length, sent[0].startsWith('🔴 Статус бота — 2026-10-06 09:00 · звіт не зібрано: '),
    sent[0].includes('no such table: status_snapshots'),
    getJobState(db, 'daily_status_last_sent'), getJobState(db, 'daily_status_fallback_sent')])
    .toEqual([1, true, true, null, '2026-10-06']);
});

test('a week of history removes the history footer', async () => {
  const db = emptyDb();
  for (const date of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) {
    saveStatusSnapshot(db, { date, metrics: GREEN_METRICS, colours: [], createdAt: `${date}T07:00:00.000Z` });
  }
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async (t) => { sent.push(t); } });
  expect(sent[0].split('\n').filter((l) => l.startsWith('ℹ️'))).toEqual([
    `ℹ️ ${EVENTS_FOOTER}`,
    'ℹ️ не виміряно: помилки /match і MCP, стан деплою, GitHub — ще не підключені (етап 2)',
  ]);
});

test('a fallback whose send throws leaves the fallback marker unset so the next tick retries', async () => {
  const db = emptyDb();
  db.exec('DROP TABLE status_snapshots');
  await dailyStatus({ db, log: silentLog, now: () => new Date('2026-10-06T07:00:00Z'), ...missingMonitor,
    notifyAdmin: async () => { throw new Error('synthetic transport unavailable'); } });
  expect(getJobState(db, 'daily_status_fallback_sent')).toBeNull();
});

test('a database that cannot be read at all still gets the fallback, once, without rejecting', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-10-06T07:00:00Z');
  // The first read (last-sent marker) must succeed for the job to proceed; close right after it.
  const realPrepare = db.prepare.bind(db);
  let reads = 0;
  db.prepare = ((sql: string) => {
    reads += 1;
    if (reads === 2) db.close();
    return realPrepare(sql);
  }) as typeof db.prepare;
  await expect(dailyStatus({ db, log: silentLog, now, ...missingMonitor,
    notifyAdmin: async (t) => { sent.push(t); } })).resolves.toBeUndefined();
  expect([sent.length, sent[0].startsWith('🔴 Статус бота — 2026-10-06 09:00 · звіт не зібрано: ')]).toEqual([1, true]);
});

const usersBlock = (text: string): string[] | undefined =>
  text.split('\n\n').find((b) => b.startsWith('Живі користувачі'))?.split('\n');

test('the users block lists extension, MCP and bug-report activity with grouped digits', async () => {
  const db = emptyDb();
  recordMatchUsage(db, { date: '2026-10-05', authed: true, beers: 12345, channel: 'extension' });
  recordMatchUsage(db, { date: '2026-10-05', authed: false, beers: 1000, channel: 'extension' });
  recordMatchUsage(db, { date: '2026-10-05', authed: true, beers: 700, channel: 'mcp' });
  recordMatchUsage(db, { date: '2026-10-05', authed: true, beers: 300, channel: 'mcp' });
  const id = insertReport(db, {
    telegramId: 101, chatId: 202, statusMessageId: 303, locale: 'uk', city: 'warszawa',
    source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown', createdAt: '2026-10-06T04:30:00.000Z',
  });
  markDone(db, id, { verdict: 'not_a_bug', issueNumber: null, processedAt: '2026-10-06T04:40:00.000Z', related: null });
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog, repo: 'ysilvestrov/warsaw-beer-bot', ...missingMonitor,
    now: () => new Date('2026-10-06T07:00:00Z'), notifyAdmin: async (t) => { sent.push(t); } });
  expect(usersBlock(sent[0])).toEqual([
    'Живі користувачі',
    '  • розширення /match (вчора): 2 запитів · 1 анонім. · 13 345 пив',
    '  • MCP /match (вчора): 2 запитів · 1 000 пив',
    '  • скарги за добу: оброблено 1 (нових 0, відкритих дублікатів 0, закритих дублікатів 0, не-баг 1), у черзі 0, потребують перевірки 0, збоїв 0',
  ]);
});

test('no extension, MCP or report traffic leaves out the users section entirely', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog, repo: 'ysilvestrov/warsaw-beer-bot', ...missingMonitor,
    now: () => new Date('2026-10-06T07:00:00Z'), notifyAdmin: async (t) => { sent.push(t); } });
  expect([sent[0].includes('Живі користувачі'), usersBlock(sent[0])]).toEqual([false, undefined]);
});
