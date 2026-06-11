import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../config/env';
import type { ApiEnv } from '../types';

// Constant-time string compare; length mismatch short-circuits to false (the
// lengths themselves are not secret).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Bearer-token auth for /admin/* maintenance endpoints, gated on ADMIN_API_TOKEN.
// Separate from the per-user Telegram-token authMiddleware: 503 when the token is
// not configured (endpoint disabled), 401 on a missing/bad token.
export function adminMiddleware(env: Env): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const expected = env.ADMIN_API_TOKEN;
    if (!expected) return c.json({ error: 'admin disabled' }, 503);
    const m = c.req.header('Authorization')?.match(/^Bearer (.+)$/);
    if (!m || !safeEqual(m[1], expected)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}
