import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Telegram } from 'telegraf';
import type { BugReportRow, ReportOutcome } from '../domain/bug-report-types';
import { createTranslator } from '../i18n';
import { toLocale } from '../storage/user_profiles';

// The extension comes from a client-supplied mime type (`image/<subtype>`). Anything but a short
// alphanumeric token — `../../x`, `svg+xml` — becomes `bin`, so the path can never leave the
// report's directory.
export function safeExt(ext: string): string {
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
}

export async function downloadMedia(
  fileId: string, download: (fileId: string) => Promise<Buffer>,
): Promise<Buffer | null> {
  try {
    return await download(fileId);
  } catch {
    return null;
  }
}

// Synchronous on purpose: the caller inserts the report and its media rows with no `await` in
// between, so the in-process worker can never pick up a report whose media is not recorded yet.
export function writeReportMediaSync(args: {
  dir: string; reportId: number; idx: number; ext: string; data: Buffer | null;
}): { path: string; bytes: number } {
  const reportDir = join(args.dir, String(args.reportId));
  const path = join(reportDir, `${args.idx}.${safeExt(args.ext)}`);
  if (!args.data) return { path, bytes: 0 };
  try {
    // Owner-only regardless of the process umask: the spec promises media is not public.
    mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'w', 0o600);
    try {
      writeFileSync(fd, args.data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { path, bytes: args.data.length };
  } catch {
    // A half-written file recorded as bytes = 0 would be invisible to pruning forever.
    try { unlinkSync(path); } catch { /* nothing was created */ }
    return { path, bytes: 0 };
  }
}

export function createNotifier(deps: {
  telegram: Pick<Telegram, 'editMessageText' | 'sendMessage'>;
  repo: string;
}): (report: BugReportRow, outcome: ReportOutcome) => Promise<void> {
  return async (report, outcome) => {
    const t = createTranslator(toLocale(report.locale) ?? 'en');
    let text: string;
    switch (outcome.kind) {
      case 'created':
      case 'duplicate_open': {
        const url = `https://github.com/${deps.repo}/issues/${outcome.issueNumber}`;
        text = t(outcome.kind === 'created' ? 'report.done.created' : 'report.done.duplicate_open', { url });
        break;
      }
      case 'duplicate_closed': {
        const url = `https://github.com/${deps.repo}/issues/${outcome.issueNumber}`;
        text = t(outcome.fixed ? 'report.done.duplicate_closed_fixed' : 'report.done.duplicate_closed',
          { date: outcome.closedAt.slice(0, 10), url });
        break;
      }
      default:
        text = t(`report.done.${outcome.kind}`);
    }
    if (report.statusMessageId === null) {
      await deps.telegram.sendMessage(report.chatId, text);
    } else {
      await deps.telegram.editMessageText(report.chatId, report.statusMessageId, undefined, text);
    }
  };
}
