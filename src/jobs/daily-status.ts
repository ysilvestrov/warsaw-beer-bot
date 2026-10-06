import type pino from 'pino';
import type { DB } from '../storage/db';
import type { BugReportSummary } from '../domain/bug-report-types';
import type { StatusMetrics } from '../storage/stats';
import { getJobState, setJobState } from '../storage/job_state';
import { saveStatusSnapshot, pruneStatusSnapshots } from '../storage/status_snapshots';
import { warsawDateAndHour } from '../domain/warsaw-time';
import { evaluateAll } from '../domain/status/evaluate';
import { computeTrends } from '../domain/status/trends';
import { renderStatusReport } from '../domain/status/render';
import { shiftDate } from '../domain/status/helpers';
import { STATUS_RULES } from '../domain/status/rules';
import { collectStatusInputs, type StatusInputOptions } from './status-inputs';

const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function buildBugReportLine(
  s: BugReportSummary, paused: { since: string; status: number } | null, repo: string,
): string | null {
  if (s.processed === 0 && s.queued === 0 && paused === null) return null;
  const lines: string[] = [];
  if (paused) {
    lines.push(`⚠️ скарги на паузі з ${paused.since.slice(0, 16).replace('T', ' ')} UTC: ключ відхилено (${paused.status})`);
  }
  lines.push(`скарги за добу: оброблено ${s.processed} (нових ${s.byVerdict.new}, відкритих дублікатів ${s.byVerdict.duplicate_open}, закритих дублікатів ${s.byVerdict.duplicate_closed}, не-баг ${s.byVerdict.not_a_bug}), у черзі ${s.queued}, потребують перевірки ${s.needsReview.length}, збоїв ${s.failed.length}`);
  for (const link of s.closedLinks) {
    lines.push(`  R-${link.reportId} → https://github.com/${repo}/issues/${link.issueNumber}`);
  }
  const review = [...s.needsReview, ...s.failed];
  if (review.length > 0) lines.push(`  перевірити: ${review.map((id) => `R-${id}`).join(', ')}`);
  return lines.join('\n');
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
  repo?: string;
  testDiagnosticsPath?: string;
  testDiagnosticsUid?: number;
}

const DAILY_STATUS_KEY = 'daily_status_last_sent';

// Stage 1 of the traffic light reads no event log yet, so an incident that ended before 09:00 is
// invisible; the report says so instead of letting 🟢 claim it (spec, "Claims and evidence").
export const EVENTS_FOOTER = 'події: ще не підключені — нічні інциденти, що вже минули, звіт поки не бачить';
// Stage 1 reads only the bug-report worker for Канали and no deploy/GitHub state for Інфраструктура,
// so a 🟢 there must not claim those inputs (spec, "Claims and evidence").
export const NOT_MEASURED_FOOTER = 'не виміряно: помилки /match і MCP, стан деплою, GitHub — ще не підключені (етап 2)';
const FALLBACK_SENT_KEY = 'daily_status_fallback_sent';
// Warsaw date a fallback was delivered in this process; covers a DB that cannot hold the marker.
let fallbackSentInProcess: string | null = null;
export function resetDailyStatusFallbackForTests(): void { fallbackSentInProcess = null; }

function buildUserLines(m: StatusMetrics, bugReportLine: string | null): string[] {
  return [
    ...(m.extMatchRequests > 0
      ? [`розширення /match (вчора): ${group(m.extMatchRequests)} запитів · ${group(m.extMatchAnon)} анонім. · ${group(m.extMatchBeers)} пив`]
      : []),
    ...(m.mcpMatchRequests > 0
      ? [`MCP /match (вчора): ${group(m.mcpMatchRequests)} запитів · ${group(m.mcpMatchBeers)} пив`]
      : []),
    ...(bugReportLine ? [bugReportLine] : []),
  ];
}

// Collect → evaluate → snapshot → render. The snapshot is written before anything is sent, so a
// failed delivery never costs a day of history; re-running the same day overwrites it.
export function buildDailyReport(db: DB, now: Date, dateKey: string, opts: StatusInputOptions): string {
  const inputs = collectStatusInputs(db, now, dateKey, opts);
  const evaluation = evaluateAll(inputs);
  saveStatusSnapshot(db, { date: dateKey, metrics: inputs.metrics, colours: evaluation.subsystems, createdAt: now.toISOString() });
  pruneStatusSnapshots(db, shiftDate(dateKey, -STATUS_RULES.snapshotRetentionDays));
  // The pause is a channel-health fact (🔴 Канали), so the users section shows activity only.
  const bugReportLine = opts.repo && inputs.bugReports
    ? buildBugReportLine(inputs.bugReports.summary, null, opts.repo)
    : null;
  return renderStatusReport({
    stamp: warsawStamp(now),
    overall: evaluation.overall,
    subsystems: evaluation.subsystems,
    footers: [...evaluation.footers, EVENTS_FOOTER, NOT_MEASURED_FOOTER],
    events: inputs.triage.line ? [inputs.triage.line] : [],
    users: buildUserLines(inputs.metrics, bugReportLine),
    trends: computeTrends(dateKey, inputs.metrics, inputs.history),
  });
}

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
  let lastSentDate: string | null = null;
  let markerReadable = true;
  try { lastSentDate = getJobState(db, DAILY_STATUS_KEY); } catch (readErr) {
    // The DB is unreadable at the very first touch: do not treat that as "never sent" and run the
    // report; go straight to the fallback, still only inside the morning window.
    markerReadable = false;
    log.error({ err: readErr }, 'daily-status: last-sent marker unreadable');
  }
  const { send, dateKey } = shouldSendDailyStatus({ now, lastSentDate });
  if (!send) {
    log.debug({ dateKey, lastSentDate }, 'daily-status: outside window or already sent');
    return;
  }
  let text: string;
  try {
    if (!markerReadable) throw new Error('daily-status: last-sent marker unreadable');
    text = buildDailyReport(db, now, dateKey, {
      repo: deps.repo, testDiagnosticsPath: deps.testDiagnosticsPath, testDiagnosticsUid: deps.testDiagnosticsUid,
    });
  } catch (e) {
    // The report itself broke. Say so once per Warsaw day instead of going silent; the delivery
    // marker stays unset, so every later tick in the window retries the full report.
    log.error({ err: e }, 'daily-status: report assembly failed');
    // Dedupe must not depend on the DB alone: a broken DB can neither read nor keep the marker.
    let alreadySent = fallbackSentInProcess === dateKey;
    if (!alreadySent) {
      try { alreadySent = getJobState(db, FALLBACK_SENT_KEY) === dateKey; } catch (readErr) {
        log.error({ err: readErr }, 'daily-status fallback marker unreadable, sending anyway');
      }
    }
    if (alreadySent) return;
    // Claimed BEFORE the await: a concurrent tick (startup catch-up + cron) must see it and stand
    // down. Released again if the send fails, so the next tick retries.
    const previous = fallbackSentInProcess;
    fallbackSentInProcess = dateKey;
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    try {
      await notifyAdmin(`🔴 Статус бота — ${warsawStamp(now)} · звіт не зібрано: ${reason}`);
      try { setJobState(db, FALLBACK_SENT_KEY, dateKey); } catch (markErr) {
        log.error({ err: markErr }, 'daily-status fallback marker not written');
      }
    } catch (sendErr) {
      // Release only our own claim: a later day's tick may have claimed it meanwhile.
      if (fallbackSentInProcess === dateKey) fallbackSentInProcess = previous;
      log.error({ err: sendErr }, 'daily-status fallback send failed');
    }
    return;
  }
  try {
    await notifyAdmin(text);
    setJobState(db, DAILY_STATUS_KEY, dateKey);
    log.info({ dateKey }, 'daily-status sent');
  } catch (e) {
    log.error({ err: e }, 'daily-status send failed');
  }
}
