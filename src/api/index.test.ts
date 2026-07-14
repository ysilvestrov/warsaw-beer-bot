import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile } from '../storage/user_profiles';
import { rotateToken, hashToken } from '../storage/api_tokens';
import type { ApiDeps } from './types';
import { createApiApp, createApiServer } from './index';
import {
  CHECKINS_SYNC_BODY_LIMIT_BYTES,
  ENRICH_CANDIDATES_BODY_LIMIT_BYTES,
  ENRICH_RESULT_BODY_LIMIT_BYTES,
  GLOBAL_BODY_LIMIT_BYTES,
  MATCH_BODY_LIMIT_BYTES,
} from './middleware/payload-limit';
import { getUsageForDate } from '../storage/api_usage';
import { warsawDateAndHour } from '../domain/warsaw-time';

function deps() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 555);
  rotateToken(db, 555, hashToken('tok'), '2026-06-07T00:00:00Z');
  const log = pino({ level: 'silent' });
  const warn = vi.spyOn(log, 'warn');
  const result = {
    db,
    env: {} as never,
    log,
  } satisfies ApiDeps;
  return { ...result, warn };
}

describe('createApiApp', () => {
  it('GET /health is open and returns ok', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('POST /match works anonymously when no token is sent (global-only)', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('POST /match rejects a present-but-invalid token with 401', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /match records anonymous usage for today', async () => {
    const d = deps();
    const app = createApiApp(d);
    await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }, { brewery: 'A', name: 'B' }] }),
    });
    const today = warsawDateAndHour(new Date()).date;
    expect(getUsageForDate(d.db, today)).toEqual({ anonRequests: 1, authedRequests: 0, beers: 2 });
  });

  it('POST /match records authenticated usage when a valid token is sent', async () => {
    const d = deps();
    const app = createApiApp(d);
    await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    const today = warsawDateAndHour(new Date()).date;
    expect(getUsageForDate(d.db, today)).toEqual({ anonRequests: 0, authedRequests: 1, beers: 1 });
  });

  it('POST /match still returns 200 when usage recording fails (best-effort)', async () => {
    const d = deps();
    d.db.exec('DROP TABLE api_usage'); // make recordMatchUsage throw inside the handler
    const app = createApiApp(d);
    const res = await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    expect(res.status).toBe(200); // the metric write must never break the response
    expect(d.warn).toHaveBeenCalled(); // failure is logged, not silent
  });

  it.each([
    ['/match', MATCH_BODY_LIMIT_BYTES],
    ['/enrich/candidates', ENRICH_CANDIDATES_BODY_LIMIT_BYTES],
    ['/enrich/result', ENRICH_RESULT_BODY_LIMIT_BYTES],
    ['/checkins/sync', CHECKINS_SYNC_BODY_LIMIT_BYTES],
  ])('rejects an oversized %s body before invalid authorization', async (path, limit) => {
    const { warn, ...apiDeps } = deps();
    const app = createApiApp(apiDeps);
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ padding: 'x'.repeat(limit) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST', path, rejectionLayer: 'route', limit,
        limitUnit: 'bytes', auth: 'invalid',
      }),
      'api payload too large',
    );
    expect((warn.mock.calls[0]?.[0] as Record<string, unknown>).telegramId).toBeUndefined();
  });

  it.each([
    ['/match', MATCH_BODY_LIMIT_BYTES, undefined, 404],
    ['/enrich/candidates', ENRICH_CANDIDATES_BODY_LIMIT_BYTES, 'Bearer nope', 401],
    ['/enrich/result', ENRICH_RESULT_BODY_LIMIT_BYTES, 'Bearer nope', 401],
    ['/checkins/sync', CHECKINS_SYNC_BODY_LIMIT_BYTES, 'Bearer nope', 401],
  ])('does not apply the POST-specific limit to GET %s', async (
    path,
    limit,
    authorization,
    expectedStatus,
  ) => {
    const { warn, ...apiDeps } = deps();
    const app = createApiApp(apiDeps);
    const headers: Record<string, string> = { 'Content-Length': String(limit + 1) };
    if (authorization) headers.Authorization = authorization;
    const request = new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: 'x',
    });
    // Fetch forbids constructing GET-with-body requests, but an upstream Node HTTP
    // request can still carry one. Override the exposed method to exercise that case.
    Object.defineProperty(request, 'method', { value: 'GET' });

    const res = await app.request(request);

    expect(res.status).toBe(expectedStatus);
    expect(res.status).not.toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['anonymous', undefined, 'anonymous', undefined],
    ['authenticated', 'Bearer tok', 'authenticated', 555],
  ])('rejects an oversized %s POST /match body at the global limit', async (
    _name,
    authorization,
    auth,
    telegramId,
  ) => {
    const { warn, ...apiDeps } = deps();
    const app = createApiApp(apiDeps);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authorization) headers.Authorization = authorization;
    const res = await app.request('/match', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        beers: [{ brewery: 'X', name: 'Y' }],
        padding: 'x'.repeat(GLOBAL_BODY_LIMIT_BYTES),
      }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: '/match',
      rejectionLayer: 'global',
      limit: GLOBAL_BODY_LIMIT_BYTES,
      limitUnit: 'bytes',
      auth,
      ...(telegramId === undefined ? {} : { telegramId }),
    });
    expect((warn.mock.calls[0]?.[0] as Record<string, unknown>).telegramId).toBe(telegramId);
  });

  it('sets permissive CORS headers', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/health', { headers: { Origin: 'https://shop.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('createApiServer', () => {
  it('tunes keep-alive to outlast the cloudflared proxy (avoids 502 socket races)', async () => {
    // Node's default keepAliveTimeout (5s) closes idle keep-alive sockets that
    // cloudflared still holds in its pool, racing a concurrent write → Cloudflare 502
    // (issue #124). Make the origin outlast the proxy so the proxy closes first;
    // headersTimeout must exceed keepAliveTimeout.
    const app = createApiApp(deps());
    const server = createApiServer(app, { API_PORT: 0 } as never, pino({ level: 'silent' })) as import('node:http').Server;
    try {
      expect(server.keepAliveTimeout).toBe(120_000);
      expect(server.headersTimeout).toBe(125_000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
