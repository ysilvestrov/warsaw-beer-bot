import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type pino from 'pino';
import type { Env } from '../config/env';
import type { ApiDeps, ApiEnv } from './types';
import { authMiddleware } from './middleware/auth';
import { matchRoute } from './routes/match';

export function createApiApp(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  // Requests originate from arbitrary shop domains; auth is a Bearer header
  // (not cookies), so a wildcard origin is safe.
  app.use('*', cors({ origin: '*' }));

  app.get('/health', (c) => c.json({ ok: true }));

  // Auth applies to /match only — /health stays open.
  app.use('/match', authMiddleware(deps.db));
  matchRoute(app, deps);

  app.onError((err, c) => {
    deps.log.error({ err }, 'api error');
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}

export function createApiServer(
  app: Hono<ApiEnv>,
  env: Env,
  log: pino.Logger,
): ServerType {
  return serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: env.API_PORT },
    (info) => log.info({ port: info.port }, 'api listening'),
  );
}
