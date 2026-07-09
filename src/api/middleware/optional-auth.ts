import type { MiddlewareHandler } from 'hono';
import type { DB } from '../../storage/db';
import type { ApiEnv } from '../types';
import { hashToken, findTelegramIdByHash } from '../../storage/api_tokens';

// Optional-auth for /match: a MISSING Authorization header is anonymous (no
// telegramId set → caller treats it as global-only). A PRESENT but invalid
// token is still rejected with 401 so a broken/typo'd token stays diagnosable.
export function optionalAuthMiddleware(db: DB): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (header === undefined) return next(); // anonymous
    const m = header.match(/^Bearer (.+)$/);
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    const telegramId = findTelegramIdByHash(db, hashToken(m[1]));
    if (telegramId === null) return c.json({ error: 'unauthorized' }, 401);
    c.set('telegramId', telegramId);
    await next();
  };
}
