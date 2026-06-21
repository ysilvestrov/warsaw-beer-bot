import pino from 'pino';
import type { StatusMetrics } from '../storage/stats';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { buildStatusMessage, dailyStatus, shouldSendDailyStatus } from './daily-status';

const silentLog = pino({ level: 'silent' });

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const base: StatusMetrics = {
  lastScrapeHoursAgo: 9.3, pubsScraped24h: 42,
  beersTotal: 12840, beersMatched: 10000, orphansPending: 287, ratingsMissing: 134,
  snapshots: 1976, taps: 29459, dbSizeMb: 13.2,
  usersTotal: 31, usersLinked: 24,
  onTapDistinct: 1118, onTapPubs: 42, newOnTap24h: 37,
};

test('buildStatusMessage: full message exact string', () => {
  const out = buildStatusMessage(base, '2026-06-05 09:00');
  expect(out).toBe(
    [
      '🍺 Статус бота — 2026-06-05 09:00',
      '',
      'Стан',
      '• Останній скрейп: 9 год тому ✅ (42 паби за 24 год)',
      "• Каталог: 12 840 пив · 78% зматчено · 287 orphan'ів у черзі",
      '• Рейтинги: 134 зматчених пив без рейтингу',
      "• БД: 1 976 snapshot'ів / 29 459 кранів · 13.2 МБ",
      "• Користувачі: 31 профіль (24 прив'язано)",
      '',
      'На кранах зараз',
      '• 1 118 унікальних пив у 42 пабах',
      '• Нових на кранах (24 год): 37',
    ].join('\n'),
  );
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

test('dailyStatus: sends the built message once when notifyAdmin is set', async () => {
  const db = emptyDb();
  const sent: string[] = [];
  await dailyStatus({
    db, log: silentLog,
    notifyAdmin: async (msg: string) => { sent.push(msg); },
    now: () => new Date('2026-06-04T07:00:00Z'),
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].startsWith('🍺 Статус бота — ')).toBe(true);
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
