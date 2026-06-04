import type { StatusMetrics } from '../storage/stats';
import { buildStatusMessage } from './daily-status';

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
