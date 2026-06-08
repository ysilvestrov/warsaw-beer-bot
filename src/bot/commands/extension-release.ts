import { Composer, Markup } from 'telegraf';
import type { Telegram } from 'telegraf';
import type pino from 'pino';
import { createHash } from 'node:crypto';
import type { BotContext } from '../index';
import type { DB } from '../../storage/db';
import { createTranslator } from '../../i18n';
import { getUserLanguage } from '../../storage/user_profiles';
import {
  latestRelease,
  attachFileId,
  listExtensionTokenHolders,
  getReleaseByVersion,
} from '../../storage/extension_releases';

const RELEASE_ZIP = /^warsaw-beer-overlay.*\.zip$/i;

export function isAdmin(ctx: BotContext): boolean {
  const id = ctx.deps.env.ADMIN_TELEGRAM_ID;
  return !!id && String(ctx.from?.id) === id;
}

// Exported for unit testing. `next` lets non-release documents fall through to
// the /import document handler (which is registered AFTER this one).
export async function handleReleaseDocument(
  ctx: BotContext & { message: { document: { file_id: string; file_name?: string } } },
  next: () => Promise<void>,
): Promise<void> {
  const doc = ctx.message.document;
  if (!isAdmin(ctx) || !RELEASE_ZIP.test(doc.file_name ?? '')) return next();

  const link = await ctx.telegram.getFileLink(doc.file_id);
  // Bound the download so a stalled Telegram CDN fetch can't hang the handler.
  const res = await fetch(link.toString(), { signal: AbortSignal.timeout(15_000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(buf).digest('hex');

  const latest = latestRelease(ctx.deps.db);
  if (!latest || latest.sha256 !== sha256) {
    await ctx.reply(ctx.t('extrel.no_match'));
    return;
  }

  attachFileId(ctx.deps.db, latest.version, doc.file_id, ctx.from!.id);
  const n = listExtensionTokenHolders(ctx.deps.db).length;
  await ctx.reply(
    ctx.t('extrel.attached', { version: latest.version, n }),
    Markup.inlineKeyboard([
      [Markup.button.callback(ctx.t('extrel.btn_send'), `extrel:send:${latest.version}`)],
      [Markup.button.callback(ctx.t('extrel.btn_cancel'), 'extrel:cancel')],
    ]),
  );
}

// Sends each token holder the release notes (as a message) + the zip (as a
// document, by file_id) in their own locale. A blocked/failed recipient is
// counted and skipped — never aborts the loop. Notes go in a separate message
// so the Telegram 1024-char caption cap is never a problem.
export async function broadcastRelease(
  telegram: Pick<Telegram, 'sendMessage' | 'sendDocument'>,
  db: DB,
  version: string,
  log?: Pick<pino.Logger, 'warn'>,
): Promise<{ sent: number; failed: number }> {
  const rel = getReleaseByVersion(db, version);
  if (!rel || !rel.file_id) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const id of listExtensionTokenHolders(db)) {
    const t = createTranslator(getUserLanguage(db, id) ?? 'uk');
    const text = `${t('extrel.new_version', { version })}\n\n${rel.notes}\n\n${t('extrel.how_to_update')}`;
    try {
      await telegram.sendMessage(id, text);
      await telegram.sendDocument(id, rel.file_id);
      sent++;
    } catch (err) {
      // A blocked recipient is expected; log so a systematic failure (bad
      // file_id, revoked bot) is diagnosable beyond the sent/failed count.
      log?.warn({ err, telegramId: id }, 'broadcast: delivery failed');
      failed++;
    }
  }
  return { sent, failed };
}

export const extensionReleaseCommand = new Composer<BotContext>();

extensionReleaseCommand.on('document', (ctx, next) =>
  handleReleaseDocument(ctx as never, next),
);

extensionReleaseCommand.action(/^extrel:send:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx as never)) return;
  const version = ctx.match[1];
  await ctx.editMessageText(ctx.t('extrel.sending', { version }));
  const { sent, failed } = await broadcastRelease(ctx.telegram, ctx.deps.db, version, ctx.deps.log);
  await ctx.reply(ctx.t('extrel.broadcast_done', { sent, failed }));
});

extensionReleaseCommand.action('extrel:cancel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx as never)) return;
  await ctx.editMessageText(ctx.t('extrel.cancelled'));
});
