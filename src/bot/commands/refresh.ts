import { Composer } from 'telegraf';
import type pino from 'pino';
import type { BotContext } from '../index';
import type { ProgressFn } from '../../jobs/progress';
import type { Translator } from '../../i18n/types';
import type { DB } from '../../storage/db';
import { listPubs } from '../../storage/pubs';
import { type NewbeersDeps, type NewbeersResult, filterPubsByQuery } from './newbeers-build';
import { getUserCity } from '../../storage/user_profiles';

const FULL_COOLDOWN_MS = 5 * 60 * 1000;
const SCOPED_COOLDOWN_MS = 30 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 2000;
const lastFullCall = new Map<number, number>();
const lastScopedCall = new Map<number, number>();

export function cooldownWindowFor(kind: 'all' | 'scoped'): number {
  return kind === 'all' ? FULL_COOLDOWN_MS : SCOPED_COOLDOWN_MS;
}

// Returns true if the call is allowed (and stamps `now`), false if still
// inside the cooldown window. Pure: caller supplies the map and clock.
export function checkAndStampCooldown(
  map: Map<number, number>,
  id: number,
  windowMs: number,
  now: number,
): boolean {
  // Absent entry = never called → always allow (independent of clock magnitude,
  // so fake/zero-based clocks in tests behave the same as Date.now() in prod).
  const prev = map.get(id);
  if (prev !== undefined && now - prev < windowMs) return false;
  map.set(id, now);
  return true;
}

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

export type RefreshScope =
  | { kind: 'all' }
  | { kind: 'scoped'; slugs: Set<string>; query: string }
  | { kind: 'pub_not_found'; query: string };

export function resolveRefreshScope(db: DB, arg: string): RefreshScope {
  const query = arg.trim();
  if (!query) return { kind: 'all' };
  const matched = filterPubsByQuery(listPubs(db), query);
  if (matched.length === 0) return { kind: 'pub_not_found', query };
  return { kind: 'scoped', slugs: new Set(matched.map((p) => p.slug)), query };
}

export function createRefreshCommand(
  run: (notify: ProgressFn, opts?: { pubSlugs?: Set<string> }) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => NewbeersResult,
) {
  const cmd = new Composer<BotContext>();
  cmd.command('refresh', async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
    const scope = resolveRefreshScope(ctx.deps.db, arg);

    if (scope.kind === 'pub_not_found') {
      await ctx.reply(ctx.t('newbeers.pub_not_found', { query: scope.query }));
      return;
    }

    const cooldownMap = scope.kind === 'all' ? lastFullCall : lastScopedCall;
    const allowed = checkAndStampCooldown(
      cooldownMap,
      ctx.from.id,
      cooldownWindowFor(scope.kind),
      Date.now(),
    );
    if (!allowed) {
      await ctx.reply(ctx.t('refresh.cooldown'));
      return;
    }

    const status = await ctx.reply(ctx.t('refresh.starting'));
    const chatId = ctx.chat.id;
    const messageId = status.message_id;
    const telegram = ctx.telegram;
    const log = ctx.deps.log;
    const t = ctx.t;
    const db = ctx.deps.db;
    const telegramId = ctx.from.id;
    const locale = ctx.locale;
    const pubSlugs = scope.kind === 'scoped' ? scope.slugs : undefined;
    const pubQuery = scope.kind === 'scoped' ? scope.query : undefined;

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
          const result = postRun({ db, telegramId, locale, t, pubQuery, city: getUserCity(db, telegramId) });
          if (result.kind === 'ok') {
            await telegram.sendMessage(chatId, result.html, { parse_mode: 'HTML' });
          } else if (result.kind === 'empty' && pubSlugs) {
            // Scoped refresh: the user asked about a specific pub, so a silent
            // "nothing new" would be confusing. Full refresh stays silent on
            // empty to avoid spamming after a successful city-wide sweep.
            await telegram.sendMessage(chatId, t('newbeers.empty'));
          }
          // 'pub_not_found' cannot occur here: a non-matching query was already
          // short-circuited above before any refresh started.
        }
      : undefined;

    // Detach the work: the refresh sweep takes minutes, but Telegraf's
    // handlerTimeout (default 90s) would otherwise kill the handler and
    // raise TimeoutError into bot.catch. Captured locals above keep the
    // background promise independent of ctx's lifetime.
    void runRefreshPipeline({
      run: (n) => run(n, { pubSlugs }),
      notify,
      t,
      log,
      postRun: postRunClosure,
    });
  });
  return cmd;
}
