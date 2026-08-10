import { Composer } from 'telegraf';
import type pino from 'pino';
import type { BotContext } from '../index';
import type { ProgressFn } from '../../jobs/progress';
import type { Translator } from '../../i18n/types';
import type { DB } from '../../storage/db';
import { listPubs } from '../../storage/pubs';
import { type NewbeersDeps, type NewbeersResult, filterPubsByQuery } from './newbeers-build';
import { getUserCity } from '../../storage/user_profiles';
import { trackProgress } from '../active-progress';
import { CITIES, type City } from '../../domain/cities';

const FULL_COOLDOWN_MS = 5 * 60 * 1000;
const SCOPED_COOLDOWN_MS = 30 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 2000;
const lastFullCall = new Map<number, number>();
const lastScopedCall = new Map<number, number>();

export type RefreshCooldownKind = 'all' | 'scoped';

export function cooldownWindowFor(kind: RefreshCooldownKind): number {
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
  | {
      kind: 'run';
      cooldown: RefreshCooldownKind;
      cities?: readonly City[];
      pubSlugs?: Set<string>;
      pubIds?: Set<number>;
      telegramIds?: Set<number>;
    }
  | { kind: 'pub_not_found'; query: string };

export interface ResolveRefreshScopeArgs {
  db: DB;
  telegramId: number;
  adminTelegramId?: string;
  city: string;
  arg: string;
}

export function resolveRefreshScope(args: ResolveRefreshScopeArgs): RefreshScope {
  const { db, telegramId, adminTelegramId, city, arg } = args;
  const query = arg.trim();
  const isAdmin = adminTelegramId != null && String(telegramId) === adminTelegramId;
  const activeCities = CITIES.filter((candidate) => candidate.slug === city);

  if (isAdmin && !query) return { kind: 'run', cooldown: 'all' };
  if (isAdmin && query.toLowerCase() === 'me') {
    return {
      kind: 'run',
      cooldown: 'all',
      cities: activeCities,
      telegramIds: new Set([telegramId]),
    };
  }
  if (!isAdmin && !query) {
    return {
      kind: 'run',
      cooldown: 'all',
      cities: activeCities,
      telegramIds: new Set([telegramId]),
    };
  }

  const matched = filterPubsByQuery(listPubs(db, isAdmin ? undefined : city), query);
  if (matched.length === 0) return { kind: 'pub_not_found', query };
  const matchedCities = new Set(matched.map((pub) => pub.city));
  const pubScope = {
    kind: 'run',
    cooldown: isAdmin ? 'all' : 'scoped',
    cities: CITIES.filter((candidate) => matchedCities.has(candidate.slug)),
    pubSlugs: new Set(matched.map((pub) => pub.slug)),
    pubIds: new Set(matched.map((pub) => pub.id)),
  } as const;
  return isAdmin ? pubScope : { ...pubScope, telegramIds: new Set([telegramId]) };
}

export interface RefreshRunOptions {
  cities?: readonly City[];
  pubSlugs?: Set<string>;
  telegramIds?: Set<number>;
}

export function createRefreshCommand(
  run: (notify: ProgressFn, opts: RefreshRunOptions) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => NewbeersResult,
) {
  const cmd = new Composer<BotContext>();
  cmd.command('refresh', async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
    const city = getUserCity(ctx.deps.db, ctx.from.id);
    const scope = resolveRefreshScope({
      db: ctx.deps.db,
      telegramId: ctx.from.id,
      adminTelegramId: ctx.deps.env.ADMIN_TELEGRAM_ID,
      city,
      arg,
    });

    if (scope.kind === 'pub_not_found') {
      await ctx.reply(ctx.t('newbeers.pub_not_found', { query: scope.query }));
      return;
    }

    const cooldownMap = scope.cooldown === 'all' ? lastFullCall : lastScopedCall;
    const allowed = checkAndStampCooldown(
      cooldownMap,
      ctx.from.id,
      cooldownWindowFor(scope.cooldown),
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
    const cities = scope.cities;
    const pubSlugs = scope.pubSlugs;
    const pubIds = scope.pubIds;
    const telegramIds = scope.telegramIds;
    const tracker = trackProgress(chatId, messageId, locale);

    const notify = makeThrottledProgress(
      async (text) => {
        tracker.update(text);
        await telegram
          .editMessageText(chatId, messageId, undefined, text)
          .catch(() => {});
      },
      PROGRESS_MIN_INTERVAL_MS,
    );

    const postRunClosure = postRun && pubIds
      ? async () => {
          const result = postRun({ db, telegramId, locale, t, pubIds, city });
          if (result.kind === 'ok') {
            await telegram.sendMessage(chatId, result.html, { parse_mode: 'HTML' });
          } else if (result.kind === 'empty') {
            await telegram.sendMessage(chatId, t('newbeers.empty'));
          }
        }
      : undefined;

    // Detach the work: the refresh sweep takes minutes, but Telegraf's
    // handlerTimeout (default 90s) would otherwise kill the handler and
    // raise TimeoutError into bot.catch. Captured locals above keep the
    // background promise independent of ctx's lifetime.
    void (async () => {
      try {
        await runRefreshPipeline({
          run: (n) => run(n, { cities, pubSlugs, telegramIds }),
          notify,
          t,
          log,
          postRun: postRunClosure,
        });
      } finally {
        tracker.release();
      }
    })();
  });
  return cmd;
}
