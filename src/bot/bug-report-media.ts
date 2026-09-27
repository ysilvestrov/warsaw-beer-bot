import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Telegram } from 'telegraf';
import type { DraftMedia } from '../domain/bug-report-flow';
import type { BugReportRow, ReportOutcome } from '../domain/bug-report-types';
import { createTranslator } from '../i18n';
import { toLocale } from '../storage/user_profiles';

export async function saveReportMedia(args: {
  dir: string;
  reportId: number;
  idx: number;
  media: DraftMedia;
  download(fileId: string): Promise<Buffer>;
}): Promise<{ path: string; bytes: number }> {
  const path = join(args.dir, String(args.reportId), `${args.idx}.${args.media.ext}`);
  try {
    const data = await args.download(args.media.fileId);
    await mkdir(join(args.dir, String(args.reportId)), { recursive: true });
    const file = await open(path, 'w');
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    return { path, bytes: data.length };
  } catch {
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
