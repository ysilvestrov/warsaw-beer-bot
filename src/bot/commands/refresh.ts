import { Composer } from 'telegraf';
import type pino from 'pino';
import type { BotContext } from '../index';
import type { ProgressFn } from '../../jobs/progress';
import type { Translator } from '../../i18n/types';
import type { NewbeersDeps, NewbeersResult } from './newbeers-build';

const COOLDOWN_MS = 5 * 60 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 2000;
const lastCall = new Map<number, number>();

export function makeThrottledProgress(
  send: (text: string) => Promise<void>,
  intervalMs: number,
  now: () => number = Date.now,
): ProgressFn {
  let lastAt = 0;
  let lastText = '';
  return async (text, opts) => {
    if (text === lastText) return;
    if (!opts?.force && now() - lastAt < intervalMs) return;
    lastAt = now();
    lastText = text;
    await send(text);
  };
}

export interface RunRefreshPipelineArgs {
  run: (notify: ProgressFn) => Promise<void>;
  notify: ProgressFn;
  t: Translator;
  log: pino.Logger;
  postRun?: () => Promise<void>;
}

export async function runRefreshPipeline(args: RunRefreshPipelineArgs): Promise<void> {
  const { run, notify, t, log, postRun } = args;
  try {
    await run(notify);
    await notify(t('refresh.done'), { force: true });
    if (postRun) {
      try {
        await postRun();
      } catch (e) {
        log.error({ err: e }, 'refresh post-run failed');
      }
    }
  } catch (e) {
    log.error({ err: e }, 'refresh failed');
    await notify(t('refresh.failed'), { force: true });
  }
}

export function createRefreshCommand(
  run: (notify: ProgressFn) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => NewbeersResult,
) {
  const cmd = new Composer<BotContext>();
  cmd.command('refresh', async (ctx) => {
    const prev = lastCall.get(ctx.from.id) ?? 0;
    if (Date.now() - prev < COOLDOWN_MS) {
      await ctx.reply(ctx.t('refresh.cooldown'));
      return;
    }
    lastCall.set(ctx.from.id, Date.now());

    const status = await ctx.reply(ctx.t('refresh.starting'));
    const chatId = ctx.chat.id;
    const messageId = status.message_id;
    const telegram = ctx.telegram;
    const log = ctx.deps.log;
    const t = ctx.t;
    const db = ctx.deps.db;
    const telegramId = ctx.from.id;
    const locale = ctx.locale;

    const notify = makeThrottledProgress(
      async (text) => {
        await telegram
          .editMessageText(chatId, messageId, undefined, text)
          .catch(() => {});
      },
      PROGRESS_MIN_INTERVAL_MS,
    );

    const postRunClosure = postRun
      ? async () => {
          const result = postRun({ db, telegramId, locale, t });
          // pubQuery is never set from /refresh, so only 'ok' and 'empty' can
          // occur here. 'empty' is intentionally silent to avoid spam after a
          // successful refresh that surfaced nothing new.
          if (result.kind === 'ok') {
            await telegram.sendMessage(chatId, result.html, { parse_mode: 'HTML' });
          }
        }
      : undefined;

    // Detach the work: the refresh sweep takes minutes, but Telegraf's
    // handlerTimeout (default 90s) would otherwise kill the handler and
    // raise TimeoutError into bot.catch. Captured locals above keep the
    // background promise independent of ctx's lifetime.
    void runRefreshPipeline({
      run,
      notify,
      t,
      log,
      postRun: postRunClosure,
    });
  });
  return cmd;
}
