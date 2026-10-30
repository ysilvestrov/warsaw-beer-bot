import type { MiddlewareHandler } from 'hono';
import type { DB } from '../../storage/db';
import type { ApiEnv } from '../types';
import { warsawDateAndHour } from '../../domain/warsaw-time';
import { resolveBearer } from './resolve-bearer';

// Optional-auth for /match: a MISSING Authorization header is anonymous (no
// telegramId set → caller treats it as global-only). A PRESENT but invalid
// token is still rejected with 401 so a broken/typo'd token stays diagnosable.
// An install token (#923) is admitted with its principal and no telegramId:
// results stay global-only, as for an anonymous caller.
export function optionalAuthMiddleware(db: DB): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const who = resolveBearer(db, c.req.header('Authorization'), warsawDateAndHour(new Date()).date);
    if (who.kind === 'none') return next(); // anonymous
    if (who.kind === 'invalid') return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', who);
    if (who.kind === 'user') c.set('telegramId', who.telegramId);
    await next();
  };
}
