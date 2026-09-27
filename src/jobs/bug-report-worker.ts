import {
  AREA_LABELS, InvalidVerdictOutputError,
  type BugReportMedia, type BugReportRow, type BugReportWorker,
  type BugReportWorkerDeps, type IssueCandidate, type IssueDetail,
  type JudgeInput, type ReportContext, type ReportOutcome, type ValidatedVerdict,
} from '../domain/bug-report-types';
import { renderDuplicateComment, renderIssueBody } from '../domain/bug-report-template';
import { validateVerdict } from '../domain/bug-report-verdict';
import { isTransient } from '../domain/transient-error';
import { warsawDayStartUtc } from '../domain/warsaw-time';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 401/402/403 mean OUR key was refused (revoked, out of credit, not allowed), not that this
// report is bad. Failing the row would fail the whole queue in one run and tell every user
// "could not process"; instead the queue waits, attempts untouched, until the key is fixed.
const CREDENTIAL_STATUSES = new Set([401, 402, 403]);

function isCredentialRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && CREDENTIAL_STATUSES.has(status);
}

function imageMime(path: string): string | null {
  const extension = path.toLowerCase().split('.').pop();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return null;
}

export function createBugReportWorker(deps: BugReportWorkerDeps): BugReportWorker {
  const { db, store } = deps;
  const dailyCap = deps.dailyCap ?? 20;
  const maxAttempts = deps.maxAttempts ?? 3;
  const candidateCacheTtlMs = deps.candidateCacheTtlMs ?? 600_000;
  let running = false;
  let candidateCache: { issues: IssueCandidate[]; fetchedAt: number } | null = null;

  async function notify(report: BugReportRow, outcome: ReportOutcome): Promise<void> {
    try {
      await deps.notify(report, outcome);
    } catch (error) {
      deps.log.warn({ reportId: report.id, error }, 'Bug report notification failed');
    }
  }

  async function candidates(): Promise<IssueCandidate[]> {
    const now = deps.now().getTime();
    if (candidateCache && now - candidateCache.fetchedAt <= candidateCacheTtlMs) {
      return candidateCache.issues;
    }
    const issues = await deps.github.listIssuesByLabels(AREA_LABELS);
    candidateCache = { issues, fetchedAt: now };
    return issues;
  }

  async function images(media: BugReportMedia[]): Promise<JudgeInput['images']> {
    const result: JudgeInput['images'] = [];
    for (const item of media) {
      const mime = item.kind === 'photo' && item.bytes > 0 && item.prunedAt === null
        ? imageMime(item.path) : null;
      if (!mime) continue;
      try {
        const data = await deps.readFile(item.path);
        result.push({ mime, base64: data.toString('base64') });
      } catch (error) {
        deps.log.warn({ reportId: item.reportId, path: item.path, error }, 'Bug report image unreadable');
      }
    }
    return result;
  }

  async function verdict(input: JudgeInput, details: IssueDetail[], source: BugReportRow['source']):
    Promise<{ value: ValidatedVerdict } | { error: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await deps.judge.judge(input);
        const result = validateVerdict(raw, details, source);
        if (result.ok) return { value: result.value };
        if (attempt === 1) return { error: result.reason };
      } catch (error) {
        if (!(error instanceof InvalidVerdictOutputError)) throw error;
        if (attempt === 1) return { error: errorMessage(error) };
      }
    }
    throw new Error('Unreachable verdict state');
  }

  async function processReport(report: BugReportRow): Promise<boolean> {
    let publishing = false;
    try {
      const selected = await deps.selector.select(
        { source: report.source, category: report.category, text: report.text },
        await candidates(),
      );
      if (selected.truncated) store.setCandidatesTruncated(db, report.id);
      const details: IssueDetail[] = [];
      for (const number of selected.numbers) {
        details.push(await deps.github.getIssueWithComments(number, 3));
      }
      const media = store.listMedia(db, report.id);
      const version = report.source === 'extension' ? deps.latestExtensionVersion() : null;
      const input: JudgeInput = {
        source: report.source, category: report.category, text: report.text,
        latestExtensionVersion: version, candidates: details, images: await images(media),
      };
      const judged = await verdict(input, details, report.source);
      if ('error' in judged) {
        store.markFailed(db, report.id, { error: judged.error, processedAt: deps.now().toISOString() });
        await notify(report, { kind: 'failed' });
        return true;
      }
      const value = judged.value;
      const processedAt = deps.now().toISOString();
      if (value.kind === 'not_a_bug') {
        store.markDone(db, report.id, { verdict: 'not_a_bug', issueNumber: null, processedAt });
        await notify(report, { kind: 'not_a_bug' });
        return true;
      }
      const ctx: ReportContext = {
        reportId: report.id, source: report.source, category: report.category,
        locale: report.locale, city: report.city, latestExtensionVersion: version,
        mediaStored: media.filter((item) => item.bytes > 0).length,
        mediaFailed: media.filter((item) => item.bytes === 0).length,
      };
      store.markPublishing(db, report.id);
      publishing = true;
      let outcome: ReportOutcome;
      if (value.kind === 'new') {
        const issueNumber = await deps.github.createIssue({
          title: value.fields.title, body: renderIssueBody(value.fields, ctx),
          labels: [...value.labels, value.severity, value.effort],
        });
        store.markDone(db, report.id, { verdict: 'new', issueNumber, processedAt });
        candidateCache = null;
        outcome = { kind: 'created', issueNumber };
      } else {
        const issueNumber = value.issue.number;
        await deps.github.commentOnIssue(issueNumber, renderDuplicateComment(value.fields, ctx));
        store.markDone(db, report.id, { verdict: value.kind, issueNumber, processedAt });
        outcome = value.kind === 'duplicate_open'
          ? { kind: 'duplicate_open', issueNumber }
          : {
              kind: 'duplicate_closed', issueNumber, closedAt: value.issue.closedAt!,
              fixed: value.issue.stateReason === 'completed',
            };
      }
      await notify(report, outcome);
      return true;
    } catch (error) {
      const message = errorMessage(error);
      if (publishing) {
        store.markNeedsReview(db, report.id, deps.now().toISOString());
        await notify(report, { kind: 'needs_review' });
        deps.log.error({ reportId: report.id, error }, 'Bug report publish uncertain');
        return true;
      }
      if (isCredentialRefusal(error)) {
        deps.log.error({ reportId: report.id, error }, 'Bug report upstream refused our credentials; queue paused');
        return false;
      }
      const attempts = store.recordAttemptError(db, report.id, message);
      if (!isTransient(error) || attempts >= maxAttempts) {
        store.markFailed(db, report.id, { error: message, processedAt: deps.now().toISOString() });
        await notify(report, { kind: 'failed' });
        return true;
      }
      deps.log.warn({ reportId: report.id, error, attempts }, 'Bug report processing will retry');
      return false;
    }
  }

  return {
    async runOnce(): Promise<void> {
      if (running) return;
      running = true;
      try {
        for (const report of store.listByStatus(db, 'publishing')) {
          store.markNeedsReview(db, report.id, deps.now().toISOString());
          await notify(report, { kind: 'needs_review' });
        }
        const queued = store.listByStatus(db, 'queued');
        for (let index = 0; index < queued.length; index++) {
          const report = queued[index];
          if (store.countProcessedSince(db, warsawDayStartUtc(deps.now())) >= dailyCap) {
            for (const deferred of queued.slice(index)) {
              if (deferred.deferredNotified) continue;
              await notify(deferred, { kind: 'deferred' });
              store.markDeferredNotified(db, deferred.id);
            }
            break;
          }
          if (!await processReport(report)) break;
        }
      } finally {
        running = false;
      }
    },
  };
}
