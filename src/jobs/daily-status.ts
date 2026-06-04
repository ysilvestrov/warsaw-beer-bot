import type { StatusMetrics } from '../storage/stats';

const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function buildStatusMessage(m: StatusMetrics, date: string): string {
  const matchPct = m.beersTotal > 0 ? Math.round((m.beersMatched / m.beersTotal) * 100) : 0;
  const scrapeLine = m.lastScrapeHoursAgo === null
    ? 'немає даних ⚠️'
    : `${Math.round(m.lastScrapeHoursAgo)} год тому ${m.lastScrapeHoursAgo > 14 ? '⚠️' : '✅'} (${m.pubsScraped24h} паби за 24 год)`;
  const sizeSuffix = m.dbSizeMb === null ? '' : ` · ${m.dbSizeMb} МБ`;
  return [
    `🍺 Статус бота — ${date}`,
    '',
    'Стан',
    `• Останній скрейп: ${scrapeLine}`,
    `• Каталог: ${group(m.beersTotal)} пив · ${matchPct}% зматчено · ${group(m.orphansPending)} orphan'ів у черзі`,
    `• Рейтинги: ${group(m.ratingsMissing)} зматчених пив без рейтингу`,
    `• БД: ${group(m.snapshots)} snapshot'ів / ${group(m.taps)} кранів${sizeSuffix}`,
    `• Користувачі: ${group(m.usersTotal)} профіль (${group(m.usersLinked)} прив'язано)`,
    '',
    'На кранах зараз',
    `• ${group(m.onTapDistinct)} унікальних пив у ${m.onTapPubs} пабах`,
    `• Нових на кранах (24 год): ${m.newOnTap24h}`,
  ].join('\n');
}
