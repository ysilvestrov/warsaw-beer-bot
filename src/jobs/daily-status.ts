import type pino from 'pino';
import type { DB } from '../storage/db';
import { collectStatus, type StatusMetrics } from '../storage/stats';

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

// Formats a Date as "YYYY-MM-DD HH:mm" in Warsaw time. sv-SE yields the
// space-separated, 24h ISO-like form we want.
function warsawStamp(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(',', '');
}

export interface DailyStatusDeps {
  db: DB;
  log: pino.Logger;
  notifyAdmin?: (msg: string) => Promise<void>;
  now?: () => Date;
}

// Daily admin health digest. No-op when notifyAdmin is undefined
// (ADMIN_TELEGRAM_ID not set), matching the other admin alerts.
export async function dailyStatus(deps: DailyStatusDeps): Promise<void> {
  const { db, log, notifyAdmin } = deps;
  if (!notifyAdmin) {
    log.debug('daily-status: no ADMIN_TELEGRAM_ID, skipping');
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  const metrics = collectStatus(db, now);
  const text = buildStatusMessage(metrics, warsawStamp(now));
  try {
    await notifyAdmin(text);
    log.info({ lastScrapeHoursAgo: metrics.lastScrapeHoursAgo }, 'daily-status sent');
  } catch (e) {
    log.error({ err: e }, 'daily-status send failed');
  }
}
