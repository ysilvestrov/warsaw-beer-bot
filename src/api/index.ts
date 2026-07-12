import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import type pino from 'pino';
import type { Env } from '../config/env';
import type { ApiDeps, ApiEnv } from './types';
import { authMiddleware } from './middleware/auth';
import { optionalAuthMiddleware } from './middleware/optional-auth';
import { adminMiddleware } from './middleware/admin';
import {
  CHECKINS_SYNC_BODY_LIMIT_BYTES,
  ENRICH_CANDIDATES_BODY_LIMIT_BYTES,
  ENRICH_RESULT_BODY_LIMIT_BYTES,
  GLOBAL_BODY_LIMIT_BYTES,
  MATCH_BODY_LIMIT_BYTES,
  payloadBodyLimit,
} from './middleware/payload-limit';
import { matchRoute } from './routes/match';
import { enrichRoute } from './routes/enrich';
import { checkinsRoute } from './routes/checkins';
import { adminRoute } from './routes/admin';

export function createApiApp(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  // Requests originate from arbitrary shop domains; auth is a Bearer header
  // (not cookies), so a wildcard origin is safe.
  app.use('*', cors({ origin: '*' }));
  app.use('*', payloadBodyLimit(deps, GLOBAL_BODY_LIMIT_BYTES, 'global'));

  app.get('/health', (c) => c.json({ ok: true }));

  // /match is optional-auth: no token → anonymous global-only; invalid token → 401.
  app.use('/match', payloadBodyLimit(deps, MATCH_BODY_LIMIT_BYTES, 'route'));
  app.use('/match', optionalAuthMiddleware(deps.db));
  matchRoute(app, deps);

  app.use(
    '/enrich/candidates',
    payloadBodyLimit(deps, ENRICH_CANDIDATES_BODY_LIMIT_BYTES, 'route'),
  );
  app.use(
    '/enrich/result',
    payloadBodyLimit(deps, ENRICH_RESULT_BODY_LIMIT_BYTES, 'route'),
  );
  app.use('/enrich/*', authMiddleware(deps.db));
  enrichRoute(app, deps);

  app.use(
    '/checkins/sync',
    payloadBodyLimit(deps, CHECKINS_SYNC_BODY_LIMIT_BYTES, 'route'),
  );
  app.use('/checkins/*', authMiddleware(deps.db));
  checkinsRoute(app, deps);

  app.use('/admin/*', adminMiddleware(deps.env));
  adminRoute(app, deps);

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
  const server = serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: env.API_PORT },
    (info) => log.info({ port: info.port }, 'api listening'),
  );
  // The Cloudflare tunnel (cloudflared) pools keep-alive connections to this
  // origin (~90s idle). Node's default keepAliveTimeout (5s) would close an idle
  // socket out from under cloudflared, racing a concurrent write → "use of closed
  // network connection" → Cloudflare 502 (issue #124). Outlast the proxy so it
  // always closes idle connections first; headersTimeout must exceed keepAliveTimeout.
  // serve() is invoked without an http2 option, so this is always a node:http server.
  const http = server as HttpServer;
  http.keepAliveTimeout = 120_000;
  http.headersTimeout = 125_000;
  return server;
}
