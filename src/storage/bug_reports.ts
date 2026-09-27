import type {
  BugReportMedia, BugReportRow, BugReportStore, BugReportSummary, NewBugReport,
  ReportStatus, Verdict,
} from '../domain/bug-report-types';
import type { DB } from './db';

interface ReportDbRow {
  id: number;
  telegram_id: number;
  chat_id: number;
  status_message_id: number | null;
  locale: string;
  city: string | null;
  source: BugReportRow['source'];
  category: BugReportRow['category'];
  text: string;
  status: ReportStatus;
  attempts: number;
  last_error: string | null;
  candidates_truncated: number;
  deferred_notified: number;
  verdict: Verdict | null;
  issue_number: number | null;
  created_at: string;
  processed_at: string | null;
  jev_json: string | null;
  related_json: string | null;
}

interface MediaDbRow {
  report_id: number;
  idx: number;
  kind: BugReportMedia['kind'];
  path: string;
  bytes: number;
  pruned_at: string | null;
}

function mapReport(row: ReportDbRow): BugReportRow {
  return {
    id: row.id, telegramId: row.telegram_id, chatId: row.chat_id,
    statusMessageId: row.status_message_id, locale: row.locale, city: row.city,
    source: row.source, category: row.category, text: row.text,
    status: row.status, attempts: row.attempts, lastError: row.last_error,
    candidatesTruncated: row.candidates_truncated !== 0,
    deferredNotified: row.deferred_notified !== 0,
    verdict: row.verdict, issueNumber: row.issue_number,
    createdAt: row.created_at, processedAt: row.processed_at,
    jevJson: row.jev_json, related: row.related_json === null ? null : JSON.parse(row.related_json) as number[],
  };
}

function mapMedia(row: MediaDbRow): BugReportMedia {
  return {
    reportId: row.report_id, idx: row.idx, kind: row.kind,
    path: row.path, bytes: row.bytes, prunedAt: row.pruned_at,
  };
}

function assertChanged(db: DB, id: number, to: string, changes: number): void {
  if (changes !== 0) return;
  const row = db.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id) as { status: string } | undefined;
  throw new Error(`bug_report ${id}: illegal transition ${row?.status ?? 'missing'} → ${to}`);
}

export function insertReport(db: DB, r: NewBugReport): number {
  const result = db.prepare(`INSERT INTO bug_reports
    (telegram_id, chat_id, status_message_id, locale, city, source, category, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.telegramId, r.chatId, r.statusMessageId, r.locale, r.city,
      r.source, r.category, r.text, r.createdAt);
  return Number(result.lastInsertRowid);
}

export function getReport(db: DB, id: number): BugReportRow | null {
  const row = db.prepare('SELECT * FROM bug_reports WHERE id = ?').get(id) as ReportDbRow | undefined;
  return row ? mapReport(row) : null;
}

export function listByStatus(db: DB, status: ReportStatus): BugReportRow[] {
  return (db.prepare('SELECT * FROM bug_reports WHERE status = ? ORDER BY id ASC')
    .all(status) as ReportDbRow[]).map(mapReport);
}

export function markPublishing(db: DB, id: number): void {
  const result = db.prepare("UPDATE bug_reports SET status = 'publishing' WHERE id = ? AND status IN ('queued')")
    .run(id);
  assertChanged(db, id, 'publishing', result.changes);
}

export function markDone(
  db: DB, id: number, v: { verdict: Verdict; issueNumber: number | null; processedAt: string; related: number[] | null },
): void {
  const result = db.prepare(`UPDATE bug_reports
    SET status = 'done', verdict = ?, issue_number = ?, processed_at = ?, related_json = ?
    WHERE id = ? AND status IN ('queued', 'publishing')`)
    .run(v.verdict, v.issueNumber, v.processedAt, v.related === null ? null : JSON.stringify(v.related), id);
  assertChanged(db, id, 'done', result.changes);
}

export function markFailed(db: DB, id: number, v: { error: string; processedAt: string }): void {
  const result = db.prepare(`UPDATE bug_reports
    SET status = 'failed', last_error = ?, processed_at = ?
    WHERE id = ? AND status IN ('queued')`)
    .run(v.error, v.processedAt, id);
  assertChanged(db, id, 'failed', result.changes);
}

export function markNeedsReview(db: DB, id: number, processedAt: string): void {
  const result = db.prepare(`UPDATE bug_reports
    SET status = 'needs_review', processed_at = ?
    WHERE id = ? AND status IN ('publishing')`)
    .run(processedAt, id);
  assertChanged(db, id, 'needs_review', result.changes);
}

export function recordAttemptError(db: DB, id: number, error: string): number {
  const result = db.prepare(`UPDATE bug_reports
    SET attempts = attempts + 1, last_error = ?
    WHERE id = ? AND status IN ('queued')`)
    .run(error, id);
  assertChanged(db, id, 'attempt_error', result.changes);
  return (db.prepare('SELECT attempts FROM bug_reports WHERE id = ?').get(id) as { attempts: number }).attempts;
}

export function setJevResponse(db: DB, id: number, json: string): void {
  const result = db.prepare(`UPDATE bug_reports SET jev_json = ? WHERE id = ? AND status = 'queued'`)
    .run(json, id);
  assertChanged(db, id, 'jev_json', result.changes);
}

export function setCandidatesTruncated(db: DB, id: number): void {
  db.prepare('UPDATE bug_reports SET candidates_truncated = 1 WHERE id = ?').run(id);
}

export function markDeferredNotified(db: DB, id: number): void {
  db.prepare('UPDATE bug_reports SET deferred_notified = 1 WHERE id = ?').run(id);
}

export function countSubmittedSince(db: DB, telegramId: number, sinceIso: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM bug_reports
    WHERE telegram_id = ? AND created_at >= ?`).get(telegramId, sinceIso) as { n: number }).n;
}

export function countProcessedSince(db: DB, sinceIso: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE processed_at >= ?')
    .get(sinceIso) as { n: number }).n;
}

export function summarizeSince(db: DB, sinceIso: string): BugReportSummary {
  const verdictCounts = db.prepare(`SELECT
    COUNT(*) FILTER (WHERE verdict = 'new') AS new,
    COUNT(*) FILTER (WHERE verdict = 'duplicate_open') AS duplicate_open,
    COUNT(*) FILTER (WHERE verdict = 'duplicate_closed') AS duplicate_closed,
    COUNT(*) FILTER (WHERE verdict = 'not_a_bug') AS not_a_bug
    FROM bug_reports WHERE status = 'done' AND processed_at >= ?`).get(sinceIso) as Record<Verdict, number>;
  const ids = (status: ReportStatus): number[] =>
    (db.prepare('SELECT id FROM bug_reports WHERE status = ? AND processed_at >= ? ORDER BY id')
      .all(status, sinceIso) as { id: number }[]).map((row) => row.id);
  const closedLinks = (db.prepare(`SELECT id AS reportId, issue_number AS issueNumber
    FROM bug_reports WHERE status = 'done' AND verdict = 'duplicate_closed'
    AND processed_at >= ? ORDER BY id`)
    .all(sinceIso) as { reportId: number; issueNumber: number }[]);
  return {
    processed: countProcessedSince(db, sinceIso), byVerdict: verdictCounts,
    queued: (db.prepare("SELECT COUNT(*) AS n FROM bug_reports WHERE status = 'queued'").get() as { n: number }).n,
    needsReview: ids('needs_review'), failed: ids('failed'), closedLinks,
  };
}

export function addMedia(db: DB, m: Omit<BugReportMedia, 'prunedAt'>): void {
  db.prepare(`INSERT INTO bug_report_media (report_id, idx, kind, path, bytes)
    VALUES (?, ?, ?, ?, ?)`).run(m.reportId, m.idx, m.kind, m.path, m.bytes);
}

export function listMedia(db: DB, reportId: number): BugReportMedia[] {
  return (db.prepare('SELECT * FROM bug_report_media WHERE report_id = ? ORDER BY idx ASC')
    .all(reportId) as MediaDbRow[]).map(mapMedia);
}

export function listPrunableMedia(db: DB, reportsCreatedBeforeIso: string): BugReportMedia[] {
  return (db.prepare(`SELECT m.* FROM bug_report_media m
    JOIN bug_reports r ON r.id = m.report_id
    WHERE m.bytes > 0 AND m.pruned_at IS NULL AND r.created_at < ?
    ORDER BY m.report_id, m.idx`)
    .all(reportsCreatedBeforeIso) as MediaDbRow[]).map(mapMedia);
}

export function markMediaPruned(db: DB, reportId: number, idx: number, prunedAt: string): void {
  db.prepare('UPDATE bug_report_media SET pruned_at = ? WHERE report_id = ? AND idx = ?')
    .run(prunedAt, reportId, idx);
}

export const bugReportStore: BugReportStore = {
  insertReport, getReport, listByStatus, markPublishing, markDone, markFailed,
  markNeedsReview, recordAttemptError, setJevResponse, setCandidatesTruncated, markDeferredNotified,
  countSubmittedSince, countProcessedSince, summarizeSince, addMedia, listMedia,
  listPrunableMedia, markMediaPruned,
};
