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
import { importCheckins, sealImportCoverage, type ImportBounds } from './import-checkins';

const BATCH_SIZE = 500;
const PROGRESS_INTERVAL_MS = 2000;
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export const importCommand = new Composer<BotContext>();

importCommand.command('import', async (ctx) => {
  await ctx.reply(ctx.t('import.prompt'));
});

importCommand.on('document', async (ctx) => {
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
  let bounds: ImportBounds | null = null;

  const report = async (text: string) => {
    await ctx.telegram
      .editMessageText(ctx.chat.id, progress.message_id, undefined, text)
      .catch(() => {});
  };

  try {
    for await (const row of iterExport(stream, format)) {
      batch.push(row);
      if (batch.length >= BATCH_SIZE) {
        bounds = await withBusyRetry(() => importCheckins(db, telegramId, batch, bounds));
        total += batch.length;
        batch = [];
        if (Date.now() - lastReport > PROGRESS_INTERVAL_MS) {
          lastReport = Date.now();
          await report(ctx.t('import.progress', { total }));
        }
      }
    }
    if (batch.length) {
      bounds = await withBusyRetry(() => importCheckins(db, telegramId, batch, bounds));
      total += batch.length;
    }
    // #587: заявку про покриття робимо рівно раз, коли файл вичерпано, і лише якщо
    // зовнішнє свідчення (лічильник профілю) її підтверджує — див. import-checkins.ts.
    await withBusyRetry(() => sealImportCoverage(db, telegramId, bounds));
    await report(ctx.t('import.done', { total, format: format.toUpperCase() }));
  } catch (e) {
    await report(ctx.t('import.failed', { total, message: (e as Error).message }));
    throw e;
  }
});
