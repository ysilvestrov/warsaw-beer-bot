import type { MiddlewareHandler } from 'hono';
import type { DB } from '../../storage/db';
import type { ApiEnv } from '../types';
import { hashToken, findTelegramIdByHash } from '../../storage/api_tokens';

export function authMiddleware(db: DB): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const m = header?.match(/^Bearer (.+)$/);
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    const telegramId = findTelegramIdByHash(db, hashToken(m[1]));
    if (telegramId === null) return c.json({ error: 'unauthorized' }, 401);
    c.set('telegramId', telegramId);
    await next();
  };
}
