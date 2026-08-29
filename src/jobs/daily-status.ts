import type pino from 'pino';
import type { DB } from '../storage/db';
import { collectStatus, type StatusMetrics } from '../storage/stats';
import { getJobState, setJobState } from '../storage/job_state';
import { warsawDateAndHour } from '../domain/warsaw-time';
import { TRIAGE_LAST_RESULT_KEY } from './orphan-triage';

const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function buildStatusMessage(
  m: StatusMetrics, date: string,
  triageLine?: string | null, saturatedLine?: string | null,
): string {
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
    `• Каталог: ${group(m.beersTotal)} пив · ${matchPct}% зматчено · ${group(m.orphansPending)} orphan'ів у черзі · ${group(m.orphansRelayQueue)} у relay-черзі`,
    `• Рейтинги: ${group(m.ratingsMissing)} зматчених пив без рейтингу`,
    `• Enrich: +${group(m.enrichMatched24h)} зматчено / ${group(m.enrichFailures24h)} провалів за 24 год · пошук ${m.untappdSearchHealthy ? '✅' : '⚠️'}`,
    ...(triageLine ? [`• ${triageLine}`] : []),
    ...(saturatedLine ? [`• ${saturatedLine}`] : []),
    // Standing state, read after today's run: #377 part B's audit. The first two
    // numbers can refute the design — see the StatusMetrics comment in stats.ts.
    `• Печатки: ${group(m.sealUnidentifiable)} unidentifiable (${group(m.sealUnidentifiableReobserved)} переспостережено) · ${group(m.sealNotABeer)} not_a_beer (+${group(m.sealNotABeer7d)}/7д) · ${group(m.sealRetiredFalsified)} спростованих retire`,
    // #421: the fix-keyed lock's own audit. `під замком` is the quota saved; a week of
    // zero unlocks while issues closed means the mechanism is dead.
    `• Замок: ${group(m.lockedRows)} під замком · ${group(m.unlocked7d)} розімкнено/7д · ${group(m.verdictsOutlived7d)} вердиктів пережили фікс/7д`,
    `• БД: ${group(m.snapshots)} snapshot'ів / ${group(m.taps)} кранів${sizeSuffix}`,
    `• Користувачі: ${group(m.usersTotal)} профіль (${group(m.usersLinked)} прив'язано)`,
    `• Розширення /match (вчора): ${group(m.extMatchRequests)} запитів · ${group(m.extMatchAnon)} анонім. · ${group(m.extMatchBeers)} пив`,
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

export interface ShouldSendArgs {
  now: Date;
  lastSentDate: string | null;
  windowStartHour?: number;
  windowEndHour?: number;
}

// Pure decision: send the digest iff the current Warsaw hour is within
// [windowStartHour, windowEndHour) and we have not already sent for this
// Warsaw date. dateKey is the date to persist on a successful send.
export function shouldSendDailyStatus(args: ShouldSendArgs): { send: boolean; dateKey: string } {
  const { now, lastSentDate, windowStartHour = 9, windowEndHour = 12 } = args;
  const { date, hour } = warsawDateAndHour(now);
  const inWindow = hour >= windowStartHour && hour < windowEndHour;
  return { send: inWindow && lastSentDate !== date, dateKey: date };
}

export interface DailyStatusDeps {
  db: DB;
  log: pino.Logger;
  notifyAdmin?: (msg: string) => Promise<void>;
  now?: () => Date;
}

const DAILY_STATUS_KEY = 'daily_status_last_sent';

// Daily admin health digest. Runs on a frequent UTC tick (and once at startup);
// the Warsaw-window + last-sent-date check makes it self-throttle to one send per
// Warsaw day and catch up after a restart inside the morning window. No-op when
// notifyAdmin is undefined (ADMIN_TELEGRAM_ID not set).
export async function dailyStatus(deps: DailyStatusDeps): Promise<void> {
  const { db, log, notifyAdmin } = deps;
  if (!notifyAdmin) {
    log.debug('daily-status: no ADMIN_TELEGRAM_ID, skipping');
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  const lastSentDate = getJobState(db, DAILY_STATUS_KEY);
  const { send, dateKey } = shouldSendDailyStatus({ now, lastSentDate });
  if (!send) {
    log.debug({ dateKey, lastSentDate }, 'daily-status: outside window or already sent');
    return;
  }
  const metrics = collectStatus(db, now);
  // Triage line: written by the orphan-triage job (earlier Warsaw window) into
  // job_state; only shown when it belongs to today's digest date.
  let triageLine: string | null = null;
  let saturatedLine: string | null = null;
  const rawTriage = getJobState(db, TRIAGE_LAST_RESULT_KEY);
  if (rawTriage) {
    try {
      const parsed = JSON.parse(rawTriage) as { date: string; line: string; saturated?: string | null };
      if (parsed.date === dateKey) {
        triageLine = parsed.line;
        // `?? null`: a payload written before #431 has no such key.
        saturatedLine = parsed.saturated ?? null;
      }
    } catch { /* malformed state — ignore */ }
  }
  const text = buildStatusMessage(metrics, warsawStamp(now), triageLine, saturatedLine);
  try {
    await notifyAdmin(text);
    setJobState(db, DAILY_STATUS_KEY, dateKey);
    log.info({ lastScrapeHoursAgo: metrics.lastScrapeHoursAgo, dateKey }, 'daily-status sent');
  } catch (e) {
    log.error({ err: e }, 'daily-status send failed');
  }
}
