import pino from 'pino';
import type { StatusMetrics } from '../storage/stats';
import type { BugReportSummary } from '../domain/bug-report-types';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { insertReport, markDone } from '../storage/bug_reports';
import { buildBugReportLine, buildStatusMessage, dailyStatus, shouldSendDailyStatus } from './daily-status';
import { getJobState, setJobState } from '../storage/job_state';
import { TRIAGE_LAST_RESULT_KEY } from './orphan-triage';
import { UNLOCK_LAST_RESULT_KEY } from './unlock-fixed-orphans';
import { BUG_REPORT_PAUSED_KEY } from './bug-report-worker';

const silentLog = pino({ level: 'silent' });

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const base: StatusMetrics = {
  lastScrapeHoursAgo: 9.3, pubsScraped24h: 42,
  beersTotal: 12840, beersMatched: 10000, orphansPending: 287, orphansRelayQueue: 751, ratingsMissing: 134, ratingsChecked30d: 30120,
  snapshots: 1976, taps: 29459, dbSizeMb: 13.2,
  usersTotal: 31, usersLinked: 24,
  onTapDistinct: 1118, onTapPubs: 42, newOnTap24h: 37,
  enrichMatched24h: 5, enrichFailures24h: 3, untappdSearchHealthy: true,
  extMatchRequests: 1234, extMatchAnon: 312, extMatchBeers: 47210,
  mcpMatchRequests: 87, mcpMatchBeers: 1940,
  sealUnidentifiable: 9, sealUnidentifiableReobserved: 7,
  sealNotABeer: 29, sealNotABeer7d: 0, sealRetiredFalsified: 28,
  lockedRows: 12, unlocked7d: 3, verdictsOutlived7d: 2,
  unrescuedRows: 4, unlockedUnadjudicated7d: 1,
};

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
    '⚠️ скарги на паузі з 12:34 UTC: ключ відхилено (402)',
    'скарги за добу: оброблено 0 (нових 0, відкритих дублікатів 0, закритих дублікатів 0, не-баг 0), у черзі 0, потребують перевірки 0, збоїв 0',
  ].join('\n'));
});

test('buildStatusMessage renders the report line with its links as one bullet', () => {
  const out = buildStatusMessage(base, '2026-06-05 09:00', null, null, null,
    'скарги за добу: оброблено 1\n  R-7 → https://github.com/example/repo/issues/3');
  expect(out).toContain('• скарги за добу: оброблено 1\n  R-7 → https://github.com/example/repo/issues/3\n');
});

test('dailyStatus includes the report digest and pause from persisted state', async () => {
  const db = emptyDb();
  const id = insertReport(db, {
    telegramId: 101, chatId: 202, statusMessageId: 303, locale: 'uk', city: 'warszawa',
    source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown', createdAt: '2026-06-21T06:30:00.000Z',
  });
  markDone(db, id, { verdict: 'not_a_bug', issueNumber: null, processedAt: '2026-06-21T06:40:00.000Z' });
  setJobState(db, BUG_REPORT_PAUSED_KEY,
    '{"since":"2026-06-21T06:50:00.000Z","status":401}');
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog, repo: 'ysilvestrov/warsaw-beer-bot',
    notifyAdmin: async (msg) => { sent.push(msg); }, now: () => new Date('2026-06-21T07:00:00.000Z') });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain([
    '• ⚠️ скарги на паузі з 06:50 UTC: ключ відхилено (401)',
    'скарги за добу: оброблено 1 (нових 0, відкритих дублікатів 0, закритих дублікатів 0, не-баг 1), у черзі 0, потребують перевірки 0, збоїв 0',
  ].join('\n'));
});

test('dailyStatus without a repo leaves out the report line', async () => {
  const db = emptyDb();
  insertReport(db, {
    telegramId: 101, chatId: 202, statusMessageId: 303, locale: 'uk', city: 'warszawa',
    source: 'bot', category: 'wrong_beer', text: 'Wrong beer shown', createdAt: '2026-06-21T06:30:00.000Z',
  });
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog,
    notifyAdmin: async (msg) => { sent.push(msg); }, now: () => new Date('2026-06-21T07:00:00.000Z') });
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain('скарги за добу:');
});

test('buildStatusMessage: full message exact string', () => {
  const out = buildStatusMessage(base, '2026-06-05 09:00');
  expect(out).toBe(
    [
      '🍺 Статус бота — 2026-06-05 09:00',
      '',
      'Стан',
      '• Останній скрейп: 9 год тому ✅ (42 паби за 24 год)',
      "• Каталог: 12 840 пив · 78% зматчено · 287 orphan'ів у черзі · 751 у relay-черзі",
      '• Рейтинги: 134 зматчених пив без рейтингу · 30 120 звірено за 30 днів',
      '• Enrich: +5 зматчено / 3 провалів за 24 год · пошук ✅',
      '• Печатки: 9 unidentifiable (7 переспостережено) · 29 not_a_beer (+0/7д) · 28 спростованих retire',
      '• Замок: 12 під замком · 3 розімкнено/7д · 2 вердиктів пережили фікс/7д · 4 unrescued (1 без негативного маркера/7д)',
      "• БД: 1 976 snapshot'ів / 29 459 кранів · 13.2 МБ",
      "• Користувачі: 31 профіль (24 прив'язано)",
      '• Розширення /match (вчора): 1 234 запитів · 312 анонім. · 47 210 пив',
      '• MCP /match (вчора): 87 запитів · 1 940 пив',
      '',
      'На кранах зараз',
      '• 1 118 унікальних пив у 42 пабах',
      '• Нових на кранах (24 год): 37',
    ].join('\n'),
  );
});

test('dailyStatus shows same-day withheld beer and issue IDs', async () => {
  const db = emptyDb();
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({
    date: '2026-06-21', withheld: [{ beerId: 29955, issueNumber: 677 }],
  }));
  const sent: string[] = [];
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (msg) => { sent.push(msg); },
    now: () => new Date('2026-06-21T07:00:00Z') });
  expect(sent[0]).toContain('#677 / beer 29955');
});

test('dailyStatus ignores stale or malformed withheld results', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const deps = { db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-21T07:00:00Z') };
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({
    date: '2026-06-20', withheld: [{ beerId: 29955, issueNumber: 677 }],
  }));
  await dailyStatus(deps);
  expect(sent[0]).not.toContain('Утримано після закриття');

  db.prepare("DELETE FROM job_state WHERE key = 'daily_status_last_sent'").run();
  setJobState(db, UNLOCK_LAST_RESULT_KEY, JSON.stringify({
    date: '2026-06-21', withheld: [{ beerId: -1, issueNumber: 677 }],
  }));
  await dailyStatus(deps);
  expect(sent[1]).not.toContain('Утримано після закриття');
});

test('buildStatusMessage: the MCP line shows zeros when there was no MCP traffic', () => {
  const out = buildStatusMessage(
    { ...base, mcpMatchRequests: 0, mcpMatchBeers: 0 },
    '2026-06-05 09:00',
  );
  expect(out).toContain('• MCP /match (вчора): 0 запитів · 0 пив');
});

test('buildStatusMessage: stale scrape (>14h) shows warning flag', () => {
  const out = buildStatusMessage({ ...base, lastScrapeHoursAgo: 15 }, '2026-06-05 09:00');
  expect(out).toContain('• Останній скрейп: 15 год тому ⚠️ (42 паби за 24 год)');
});

test('buildStatusMessage: no snapshots shows немає даних', () => {
  const out = buildStatusMessage({ ...base, lastScrapeHoursAgo: null }, '2026-06-05 09:00');
  expect(out).toContain('• Останній скрейп: немає даних ⚠️');
});

test('buildStatusMessage: null dbSizeMb omits size suffix', () => {
  const out = buildStatusMessage({ ...base, dbSizeMb: null }, '2026-06-05 09:00');
  expect(out).toContain("• БД: 1 976 snapshot'ів / 29 459 кранів\n");
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

it('renders the enrich line with health icon', () => {
  const m = { ...base, enrichMatched24h: 7, enrichFailures24h: 12, untappdSearchHealthy: true };
  const text = buildStatusMessage(m, '2026-06-28 10:00');
  expect(text).toContain('Enrich: +7 зматчено / 12 провалів за 24 год · пошук ✅');
});

it('shows ⚠️ when search is unhealthy', () => {
  const m = { ...base, enrichMatched24h: 0, enrichFailures24h: 0, untappdSearchHealthy: false };
  expect(buildStatusMessage(m, '2026-06-28 10:00')).toContain('пошук ⚠️');
});

test('buildStatusMessage: includes triage line when provided', () => {
  const out = buildStatusMessage(base, '2026-07-05 09:00', 'Тріаж: 7 нових → 2 до #228');
  const lines = out.split('\n');
  const enrichIdx = lines.findIndex((l) => l.startsWith('• Enrich:'));
  expect(lines[enrichIdx + 1]).toBe('• Тріаж: 7 нових → 2 до #228');
});

test('buildStatusMessage: no triage line when null/omitted', () => {
  expect(buildStatusMessage(base, '2026-07-05 09:00')).not.toContain('Тріаж');
  expect(buildStatusMessage(base, '2026-07-05 09:00', null)).not.toContain('Тріаж');
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

test('#431: the saturated line rides beside the triage line', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  const now = () => new Date('2026-07-05T07:30:00Z'); // 09:30 Warsaw
  setJobState(db, TRIAGE_LAST_RESULT_KEY, JSON.stringify({
    date: '2026-07-05', line: 'Тріаж: 50 нових',
    saturated: 'Насичені: #405 (21) — усього 1',
  }));
  await dailyStatus({ db, log: silentLog, notifyAdmin: async (m) => { sent.push(m); }, now });
  expect(sent[0]).toContain('• Тріаж: 50 нових');
  expect(sent[0]).toContain('• Насичені: #405 (21) — усього 1');
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

test('#431: buildStatusMessage omits the bullet when the saturated line is null', () => {
  expect(buildStatusMessage(base, '2026-07-05 09:00', 'Тріаж: 1 нових', null))
    .not.toContain('Насичені');
});
