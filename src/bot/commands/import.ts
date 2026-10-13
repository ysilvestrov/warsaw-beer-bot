import { Composer } from 'telegraf';
import { Readable } from 'node:stream';
import type { BotContext } from '../index';
import {
  iterExport,
  detectFormat,
  type Checkin,
  type ExportFormat,
} from '../../sources/untappd/export';
import { ensureProfile } from '../../storage/user_profiles';
import { withBusyRetry } from '../../storage/busy-retry';
import { getHistoryOwner, isCurrentHistoryOwner } from '../../storage/history-owner';
import { noteFailure } from '../handler-failure';
import { importCheckins, ImportAccountChangedError } from './import-checkins';

const BATCH_SIZE = 500;
const PROGRESS_INTERVAL_MS = 2000;
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

// #836: the file is the person's own data and a parser error quotes it («…value is "<their venue>"»),
// so handler_failures gets the KIND of an import error — its code, or failing that its class —
// and never its message.
export function importFailureKind(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return e instanceof Error ? e.name : 'unknown';
}

export const importCommand = new Composer<BotContext>();

importCommand.command('import', async (ctx) => {
  await ctx.reply(ctx.t('import.prompt'));
});

// A caption that is a command addresses that command (/fest stands takes its CSV this way): the
// document is not an export, and this composer runs before theirs, so it hands the update on.
// A caption of /import itself is still an import.
const COMMAND_CAPTION_RE = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/;

importCommand.on('document', async (ctx, next) => {
  const command = COMMAND_CAPTION_RE.exec(ctx.message.caption ?? '')?.[1];
  if (command !== undefined && command.toLowerCase() !== 'import') return next();
  const doc = ctx.message.document;
  const name = doc.file_name ?? '';

  let format: ExportFormat;
  try {
    format = detectFormat(name);
  } catch {
    await ctx.reply(ctx.t('import.unsupported_format'));
    return;
  }

  if (doc.file_size && doc.file_size > TG_DOWNLOAD_LIMIT) {
    await ctx.reply(ctx.t('import.too_large'));
    return;
  }

  ensureProfile(ctx.deps.db, ctx.from.id);
  const owner = getHistoryOwner(ctx.deps.db, ctx.from.id);

  const link = await ctx.telegram.getFileLink(doc.file_id);
  const res = await fetch(link.toString());
  if (!res.ok || !res.body) {
    await ctx.reply(ctx.t('import.fetch_failed'));
    return;
  }
  const stream = Readable.fromWeb(res.body as never);

  const progress = await ctx.reply(ctx.t('import.starting'));
  const db = ctx.deps.db;
  const telegramId = ctx.from.id;

  let total = 0;
  let batch: Checkin[] = [];
  let lastReport = Date.now();

  const report = async (text: string) => {
    await ctx.telegram
      .editMessageText(ctx.chat.id, progress.message_id, undefined, text)
      .catch(() => {});
  };

  try {
    for await (const row of iterExport(stream, format)) {
      batch.push(row);
      if (batch.length >= BATCH_SIZE) {
        await withBusyRetry(() => importCheckins(db, telegramId, batch, owner));
        total += batch.length;
        batch = [];
        if (Date.now() - lastReport > PROGRESS_INTERVAL_MS) {
          lastReport = Date.now();
          await report(ctx.t('import.progress', { total }));
        }
      }
    }
    if (batch.length) {
      await withBusyRetry(() => importCheckins(db, telegramId, batch, owner));
      total += batch.length;
    }
    if (!isCurrentHistoryOwner(db, owner)) throw new ImportAccountChangedError();
    await report(ctx.t('import.done', { total, format: format.toUpperCase() }));
  } catch (e) {
    if (e instanceof ImportAccountChangedError) {
      await report(ctx.t('import.account_changed', { total, username: owner.accountKey || ctx.t('import.unlinked') }));
      return;
    }
    await report(ctx.t('import.failed', { total, message: (e as Error).message }));
    // Not re-thrown (#836): bot.catch would answer the person a second time and record the
    // failure under the update type instead of the command.
    ctx.deps.log.error({ err: e, total }, 'import failed');
    noteFailure(ctx.deps, '/import', new Error(importFailureKind(e)));
  } finally {
    stream.destroy();
  }
});
