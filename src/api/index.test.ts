import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile } from '../storage/user_profiles';
import { rotateToken, hashToken } from '../storage/api_tokens';
import { createApiApp } from './index';

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
