import type pino from 'pino';
import type { DB } from '../storage/db';
import type { AppDeps, BotContext } from './index';
import { recordHandlerFailure } from '../storage/handler_failures';
import { createTranslator } from '../i18n';
import { failureSource } from './failure-source';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Telegraf wraps every handler in p-timeout (handlerTimeout, 90 s). The handler is NOT cancelled —
// it keeps running — so "failed" would be a claim we cannot make to the person.
const isHandlerTimeout = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError';

/** #836: records a failure for the daily status. Bookkeeping must never break the answer, so it never throws. */
export function noteFailure(
  deps: { db: DB; log: pino.Logger },
  source: string,
  err: unknown,
  now: Date = new Date(),
): void {
  try {
    recordHandlerFailure(deps.db, { at: now.toISOString(), source, error: errorText(err) });
  } catch (e) {
    deps.log.error({ err: e, source }, 'handler failure not recorded');
  }
}

// An update of a shape failureSource does not expect must not turn the error handler into a thrower.
function sourceOf(ctx: BotContext): string {
  try {
    return failureSource(ctx.update);
  } catch {
    return 'unknown';
  }
}

/** #836: everything a handler did not catch itself ends here. Never throws. */
export async function onHandlerFailure(deps: AppDeps, err: unknown, ctx: BotContext, now: Date = new Date()): Promise<void> {
  deps.log.error({ err, update: ctx.update }, 'bot error');
  noteFailure(deps, sourceOf(ctx), err, now);
  if (isHandlerTimeout(err) || ctx.chat === undefined) return;
  // ctx.t is missing when the i18n middleware itself failed; 'en' is that middleware's own default.
  const t = ctx.t ?? createTranslator('en');
  try {
    await ctx.reply(t('app.handler_failed'));
  } catch (e) {
    deps.log.warn({ err: e }, 'handler failure reply not sent');
  }
}
