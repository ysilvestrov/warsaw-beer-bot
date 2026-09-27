// Contracts for the /report pipeline (spec:
// docs/superpowers/specs/2026-09/2026-09-26-bug-report-design.md). Types and interface
// signatures only — every implementing module imports from here, so the packages of the
// core plan can be built in parallel. Changing a contract is a plan change, not an
// implementation detail.

import type { DB } from '../storage/db';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ReportSource = 'bot' | 'extension';

export const REPORT_CATEGORIES = [
  'wrong_beer', 'no_rating', 'had_status', 'stale_data', 'route',
  'no_badge', 'ext_broken', 'bot_broken', 'text_ui', 'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

// The four labels that make an issue a dedup candidate AND the only area labels the
// verdict step may choose.
export const AREA_LABELS = ['bug', 'extension-bug', 'parser-bug', 'matcher-bug'] as const;
export type AreaLabel = (typeof AREA_LABELS)[number];

export const USER_REPORT_LABEL = 'user-report';

export const SEVERITIES = ['Severity-1', 'Severity-2', 'Severity-3', 'Severity-4'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const EFFORTS = ['effort/S', 'effort/M', 'effort/L'] as const;
export type Effort = (typeof EFFORTS)[number];

export const VERDICTS = ['new', 'duplicate_open', 'duplicate_closed', 'not_a_bug'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const REPORT_STATUSES = ['queued', 'publishing', 'done', 'failed', 'needs_review'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface CategoryDef {
  key: ReportCategory;
  sources: readonly ReportSource[];
  hintLabel: AreaLabel;
}

// ---------------------------------------------------------------------------
// Template fields (spec § "Крок 2" schema; camelCase here, snake_case on the wire)
// ---------------------------------------------------------------------------

export interface TemplateFields {
  title: string;          // <= 100
  summary: string;        // <= 300
  where: string;          // <= 200
  subjects: string[];     // <= 5 x 100
  expected: string;       // <= 200
  actual: string;         // <= 200
  steps: string[];        // <= 5 x 150
  screenEvidence: string[]; // <= 5 x 150
  newEvidence: string;    // <= 300
}

// The verdict step's output after JSON parse and snake→camel mapping, BEFORE validation.
// `labels` is raw: it may contain anything the model returned.
export interface RawVerdict extends TemplateFields {
  verdict: Verdict;
  issueNumber: number | null;
  labels: string[];
  severity: Severity;
  effort: Effort;
  related: number[];
}

// ---------------------------------------------------------------------------
// GitHub-side shapes
// ---------------------------------------------------------------------------

export interface IssueCandidate {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;        // ISO
  closedAt: string | null;  // ISO
}

export interface IssueComment {
  createdAt: string;
  body: string;
}

export interface IssueDetail extends IssueCandidate {
  body: string;
  stateReason: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null;
  comments: IssueComment[]; // the LAST n comments, oldest first
}

// ---------------------------------------------------------------------------
// Report context used for rendering (code-owned fields; the LLM never writes these)
// ---------------------------------------------------------------------------

export interface ReportContext {
  reportId: number;
  source: ReportSource;
  category: ReportCategory;
  locale: string;
  city: string | null;
  latestExtensionVersion: string | null; // only meaningful for source = 'extension'
  mediaStored: number;  // files saved on the server (bytes > 0)
  mediaFailed: number;  // files that could not be downloaded (bytes = 0)
}

// ---------------------------------------------------------------------------
// Validation result (domain/bug-report-verdict.ts)
// ---------------------------------------------------------------------------

export type ValidatedVerdict =
  | { kind: 'new'; fields: TemplateFields; labels: string[]; severity: Severity; effort: Effort; related: number[] }
  | { kind: 'duplicate_open'; issue: IssueDetail; fields: TemplateFields; related: number[] }
  | { kind: 'duplicate_closed'; issue: IssueDetail; fields: TemplateFields; related: number[] }
  | { kind: 'not_a_bug' };

export type ValidationResult =
  | { ok: true; value: ValidatedVerdict }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// What the user is told (the periphery renders it via i18n)
// ---------------------------------------------------------------------------

export type ReportOutcome =
  | { kind: 'created'; issueNumber: number }
  | { kind: 'duplicate_open'; issueNumber: number }
  | { kind: 'duplicate_closed'; issueNumber: number; closedAt: string; fixed: boolean }
  | { kind: 'not_a_bug' }
  | { kind: 'deferred' }      // over the daily cap; stays queued
  | { kind: 'needs_review' }  // found in `publishing` after a crash
  | { kind: 'failed' };       // retries exhausted or invalid output twice

// ---------------------------------------------------------------------------
// Storage rows (storage/bug_reports.ts)
// ---------------------------------------------------------------------------

export interface NewBugReport {
  telegramId: number;
  chatId: number;
  statusMessageId: number | null;
  locale: string;
  city: string | null;
  source: ReportSource;
  category: ReportCategory;
  text: string;
  createdAt: string; // ISO UTC
}

export interface BugReportRow extends NewBugReport {
  id: number;
  status: ReportStatus;
  attempts: number;
  lastError: string | null;
  candidatesTruncated: boolean;
  deferredNotified: boolean; // the user was already told "over the cap, later" — tell once
  verdict: Verdict | null;
  issueNumber: number | null;
  processedAt: string | null;
  jevJson: string | null;
  related: number[] | null;
}

export type MediaKind = 'photo' | 'video';

export interface BugReportMedia {
  reportId: number;
  idx: number;
  kind: MediaKind;
  path: string;
  bytes: number; // 0 = download failed
  prunedAt: string | null;
}

export interface BugReportSummary {
  processed: number;
  byVerdict: Record<Verdict, number>;
  queued: number;
  needsReview: number[]; // report ids
  failed: number[];      // report ids
  closedLinks: { reportId: number; issueNumber: number }[];
}

export interface BugReportStore {
  insertReport(db: DB, r: NewBugReport): number;
  getReport(db: DB, id: number): BugReportRow | null;
  listByStatus(db: DB, status: ReportStatus): BugReportRow[]; // oldest first (id ASC)
  markPublishing(db: DB, id: number): void;
  markDone(db: DB, id: number, v: { verdict: Verdict; issueNumber: number | null; processedAt: string; related: number[] | null }): void;
  setJevResponse(db: DB, id: number, json: string): void;
  markFailed(db: DB, id: number, v: { error: string; processedAt: string }): void;
  markNeedsReview(db: DB, id: number, processedAt: string): void;
  recordAttemptError(db: DB, id: number, error: string): number; // returns the new attempts count
  setCandidatesTruncated(db: DB, id: number): void;
  markDeferredNotified(db: DB, id: number): void;
  countSubmittedSince(db: DB, telegramId: number, sinceIso: string): number;
  countProcessedSince(db: DB, sinceIso: string): number;
  summarizeSince(db: DB, sinceIso: string): BugReportSummary;
  addMedia(db: DB, m: Omit<BugReportMedia, 'prunedAt'>): void;
  listMedia(db: DB, reportId: number): BugReportMedia[]; // idx ASC
  listPrunableMedia(db: DB, reportsCreatedBeforeIso: string): BugReportMedia[];
  markMediaPruned(db: DB, reportId: number, idx: number, prunedAt: string): void;
}

// ---------------------------------------------------------------------------
// LLM and GitHub seams (infra/*)
// ---------------------------------------------------------------------------

export interface SelectInput {
  source: ReportSource;
  category: ReportCategory;
  text: string;
}

export interface JevResponse { model: string; probabilities: Record<string, number> }
export interface SelectResult { numbers: number[]; truncated: boolean; response: JevResponse }

export interface IssueSelector {
  // Returns up to 5 candidate issue numbers, most probable first, `none` removed.
  // `truncated` = the candidate list had to be cut to fit the model's context.
  // `response` is Jev's raw answer, persisted for audit.
  select(input: SelectInput, candidates: IssueCandidate[]): Promise<SelectResult>;
}

export interface VerdictImage {
  mime: string;   // image/png | image/jpeg | image/webp
  base64: string;
}

export interface JudgeInput {
  source: ReportSource;
  category: ReportCategory;
  text: string;
  latestExtensionVersion: string | null;
  candidates: IssueDetail[];
  images: VerdictImage[];
}

export interface VerdictJudge {
  // Throws on transport/HTTP failure (HttpStatusError for status codes, so isTransient
  // classifies it) and InvalidVerdictOutputError when the content is not parseable
  // into RawVerdict.
  judge(input: JudgeInput): Promise<RawVerdict>;
}

export class InvalidVerdictOutputError extends Error {}

export interface BugReportGithub {
  listIssuesByLabels(labels: readonly string[]): Promise<IssueCandidate[]>;
  getIssueWithComments(issueNumber: number, lastComments: number): Promise<IssueDetail>;
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<number>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worker (jobs/bug-report-worker.ts)
// ---------------------------------------------------------------------------

export interface BugReportWorkerDeps {
  db: DB;
  store: BugReportStore;
  github: BugReportGithub;
  selector: IssueSelector;
  judge: VerdictJudge;
  readFile(path: string): Promise<Buffer>;
  notify(report: BugReportRow, outcome: ReportOutcome): Promise<void>;
  latestExtensionVersion(): string | null;
  now(): Date;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
  dailyCap?: number;          // default 20
  maxAttempts?: number;       // default 3
  candidateCacheTtlMs?: number; // default 600_000
}

export interface BugReportWorker {
  // Processes queued reports oldest-first until the queue is empty or the daily cap is
  // reached. Re-entrant calls while a run is in flight return immediately.
  runOnce(): Promise<void>;
}
