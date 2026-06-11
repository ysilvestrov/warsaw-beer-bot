import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile } from '../storage/user_profiles';
import { rotateToken, hashToken } from '../storage/api_tokens';
import { createApiApp, createApiServer } from './index';

function deps() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 555);
  rotateToken(db, 555, hashToken('tok'), '2026-06-07T00:00:00Z');
  return { db, env: {} as never, log: pino({ level: 'silent' }) };
}

describe('createApiApp', () => {
  it('GET /health is open and returns ok', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('POST /match requires a valid token', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    expect(res.status).toBe(401);
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
