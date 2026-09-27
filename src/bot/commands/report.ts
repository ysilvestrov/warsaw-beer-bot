import { rmSync } from 'node:fs';
import { Composer, Markup } from 'telegraf';
import type { BotContext } from '../index';
import type { Messages } from '../../i18n/types';
import { categoriesFor } from '../../domain/bug-report-categories';
import {
  REPORT_CATEGORIES, type ReportCategory, type ReportSource,
} from '../../domain/bug-report-types';
import {
  stepFlow, type DraftMedia, type FlowEvent, type Keyboard, type Reply,
} from '../../domain/bug-report-flow';
import { warsawDayStartUtc } from '../../domain/warsaw-time';
import { addMedia, countSubmittedSince, insertReport } from '../../storage/bug_reports';
import { clearBan, deleteDraft, getDraft, isBanned, saveDraft, setBan } from '../../storage/bug_report_drafts';
import { getUserCity } from '../../storage/user_profiles';
import { downloadMedia, writeReportMediaSync } from '../bug-report-media';

export interface ReportCommandDeps {
  available: boolean;
  mediaDir: string | null;
  now: () => Date;
  triggerWorker: () => void;
  downloadFile: (fileId: string) => Promise<Buffer>;
}

function keyboard(ctx: BotContext, spec: Keyboard) {
  switch (spec.kind) {
    case 'sources':
      return Markup.inlineKeyboard([[
        Markup.button.callback(ctx.t('report.source.bot'), 'report:src:bot'),
        Markup.button.callback(ctx.t('report.source.extension'), 'report:src:extension'),
      ]]);
    case 'categories':
      return Markup.inlineKeyboard(categoriesFor(spec.source).map(({ key }) => [
        Markup.button.callback(ctx.t(`report.cat.${key}`), `report:cat:${key}`),
      ]));
    case 'media':
      return Markup.inlineKeyboard([[
        Markup.button.callback(ctx.t('report.btn.done'), 'report:done'),
        Markup.button.callback(ctx.t('report.btn.no_media'), 'report:done'),
      ]]);
    case 'confirm':
      return Markup.inlineKeyboard([[
        Markup.button.callback(ctx.t('report.btn.send'), 'report:send'),
        Markup.button.callback(ctx.t('report.btn.cancel'), 'report:cancel'),
      ]]);
  }
}

function renderReply(ctx: BotContext, reply: Reply) {
  const params = Object.fromEntries(Object.entries(reply.params ?? {}).map(([key, value]) => [
    key, typeof value === 'object' ? ctx.t(value.t as keyof Messages) : value,
  ]));
  const text = ctx.t(reply.key as keyof Messages, params);
  return reply.keyboard ? ctx.reply(text, keyboard(ctx, reply.keyboard)) : ctx.reply(text);
}

export function createReportCommand(deps: ReportCommandDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();

  async function handle(ctx: BotContext, event: FlowEvent, next: () => Promise<void>): Promise<void> {
    const db = ctx.deps.db;
    const telegramId = ctx.from!.id;
    const now = deps.now();
    const stored = getDraft(db, telegramId);
    const result = stepFlow(stored, event, now);
    // Synchronous, before the first await: a submit claims its draft here. Telegraf handles
    // updates concurrently, so a double-tapped "Send" must find the draft already gone (the
    // second press gets "expired"), or it files the same report twice. The cost — a crash
    // during the downloads loses that report — is accepted in the spec.
    if (result.draft) saveDraft(db, telegramId, result.draft);
    else deleteDraft(db, telegramId);
    for (const reply of result.replies) await renderReply(ctx, reply);
    if (result.submission) {
      if (!deps.available || !deps.mediaDir) {
        await ctx.reply(ctx.t('report.unavailable'));
        return;
      }
      const accepted = await ctx.reply(ctx.t('report.accepted'));
      const buffers: (Buffer | null)[] = [];
      for (const media of result.submission.media) {
        buffers.push(await downloadMedia(media.fileId, deps.downloadFile));
      }
      const mediaDir = deps.mediaDir;
      // No `await` from here to triggerWorker: the worker runs in this process, and a report
      // visible before its media rows would be judged without screenshots and published as
      // "no media".
      const submission = result.submission;
      const written: string[] = [];
      // One transaction: a crash or DB error between the report row and its media rows rolls
      // both back, so no restart can find a queued report missing its evidence.
      try {
        db.transaction(() => {
        const reportId = insertReport(db, {
          telegramId, chatId: ctx.chat!.id, statusMessageId: accepted.message_id,
          locale: ctx.locale, city: getUserCity(db, telegramId),
          source: submission.source, category: submission.category,
          text: submission.text, createdAt: now.toISOString(),
        });
        for (const [idx, media] of submission.media.entries()) {
          const saved = writeReportMediaSync({
            dir: mediaDir, reportId, idx, ext: media.ext, data: buffers[idx],
          });
          if (saved.bytes > 0) written.push(saved.path);
          addMedia(db, { reportId, idx, kind: media.kind, ...saved });
        }
        })();
      } catch (error) {
        // A thrown error (not a crash) after the claim: give the draft back at the confirm step so
        // one more press retries, and remove files the rolled-back rows no longer track. This
        // cannot reopen the double-tap: the draft returns only after this press has failed.
        for (const path of written) {
          try { rmSync(path, { force: true }); } catch { /* recovery must still reach the draft */ }
        }
        // Only if the user has not started a new draft meanwhile (possible during the downloads).
        if (stored && !getDraft(db, telegramId)) {
          saveDraft(db, telegramId, { ...stored, updatedAt: now.toISOString() });
        }
        ctx.deps.log.error({ err: error, telegramId }, 'bug report submission failed');
        await ctx.reply(ctx.t('report.retry'));
        return;
      }
      deps.triggerWorker();
    }
    if (result.passThrough) await next();
  }

  function submittedToday(ctx: BotContext): number {
    return countSubmittedSince(ctx.deps.db, ctx.from!.id, warsawDayStartUtc(deps.now()));
  }

  composer.command('report', async (ctx, next) => {
    await handle(ctx, {
      type: 'start', submittedToday: submittedToday(ctx), banned: isBanned(ctx.deps.db, ctx.from.id),
      available: deps.available, privateChat: ctx.chat.type === 'private',
    }, next);
  });

  composer.command('cancel', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    await handle(ctx, { type: 'cancel' }, next);
  });

  composer.command('reportban', async (ctx, next) => {
    if (ctx.chat.type !== 'private' || String(ctx.from.id) !== ctx.deps.env.ADMIN_TELEGRAM_ID) {
      return next();
    }
    const match = /^\/reportban\s+(\d+)(?:\s+(off))?\s*$/.exec(ctx.message.text);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      await ctx.reply(ctx.t('reportban.usage'));
      return;
    }
    if (match?.[2] === 'off') {
      clearBan(ctx.deps.db, id);
      await ctx.reply(ctx.t('reportban.unbanned', { id }));
    } else {
      setBan(ctx.deps.db, id, deps.now().toISOString());
      await ctx.reply(ctx.t('reportban.banned', { id }));
    }
  });

  composer.action(/^report:(src|cat|done|send|cancel):?(.*)$/, async (ctx, next) => {
    await ctx.answerCbQuery();
    if (ctx.chat?.type !== 'private') return next();
    const [, kind, value] = ctx.match;
    let event: FlowEvent;
    if (kind === 'src' && (value === 'bot' || value === 'extension')) {
      event = { type: 'pick_source', source: value as ReportSource };
    } else if (kind === 'cat' && REPORT_CATEGORIES.includes(value as ReportCategory)) {
      event = { type: 'pick_category', category: value as ReportCategory };
    } else if (kind === 'done') {
      event = { type: 'media_done' };
    } else if (kind === 'send') {
      event = { type: 'submit', submittedToday: submittedToday(ctx), banned: isBanned(ctx.deps.db, ctx.from.id) };
    } else if (kind === 'cancel') {
      event = { type: 'cancel' };
    } else {
      return;
    }
    await handle(ctx, event, next);
  });

  composer.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    await handle(ctx, { type: 'text', text: ctx.message.text }, next);
  });
  composer.on('photo', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const photo = ctx.message.photo.at(-1);
    if (!photo) return next();
    const media: DraftMedia = { fileId: photo.file_id, kind: 'photo',
      fileSize: photo.file_size ?? null, ext: 'jpg' };
    await handle(ctx, { type: 'media', media }, next);
  });
  composer.on('video', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const video = ctx.message.video;
    const media: DraftMedia = { fileId: video.file_id, kind: 'video',
      fileSize: video.file_size ?? null, ext: video.mime_type === 'video/quicktime' ? 'mov' : 'mp4' };
    await handle(ctx, { type: 'media', media }, next);
  });
  composer.on('document', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const document = ctx.message.document;
    if (!document.mime_type?.startsWith('image/')) return next();
    const subtype = document.mime_type.slice('image/'.length);
    const media: DraftMedia = { fileId: document.file_id, kind: 'photo',
      fileSize: document.file_size ?? null, ext: subtype === 'jpeg' ? 'jpg' : subtype };
    await handle(ctx, { type: 'media', media }, next);
  });

  return composer;
}
