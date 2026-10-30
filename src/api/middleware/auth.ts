import type { MiddlewareHandler } from 'hono';
import type { DB } from '../../storage/db';
import type { ApiEnv } from '../types';
import { warsawDateAndHour } from '../../domain/warsaw-time';
import { resolveBearer } from './resolve-bearer';

// A route behind this middleware needs a Telegram user unless it opts in with `allowInstall`. An
// install token (#923) is a known caller without one, so where it is not admitted it gets 403 rather
// than 401: the token is fine, the route is not for it. Where it is admitted (/enrich/*, which
// verifies an install's result itself), it passes with its principal and no telegramId.
export function authMiddleware(db: DB, opts: { allowInstall?: boolean } = {}): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const who = resolveBearer(db, c.req.header('Authorization'), warsawDateAndHour(new Date()).date);
    if (who.kind === 'none' || who.kind === 'invalid') return c.json({ error: 'unauthorized' }, 401);
    if (who.kind === 'install') {
      if (!opts.allowInstall) return c.json({ error: 'install_token_not_allowed' }, 403);
      c.set('principal', who);
      return next();
    }
    c.set('principal', who);
    c.set('telegramId', who.telegramId);
    await next();
  };
}
