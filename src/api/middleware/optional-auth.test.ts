import { Hono } from 'hono';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { optionalAuthMiddleware } from './optional-auth';
import type { ApiEnv } from '../types';

function appWithOptionalAuth() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 777);
  rotateToken(db, 777, hashToken('good-token'), '2026-06-07T00:00:00Z');
  const app = new Hono<ApiEnv>();
  app.use('/probe', optionalAuthMiddleware(db));
  app.get('/probe', (c) => c.json({ telegramId: c.get('telegramId') ?? null }));
  return app;
}

describe('optionalAuthMiddleware', () => {
  it('passes anonymously (telegramId null) when the Authorization header is missing', async () => {
    const res = await appWithOptionalAuth().request('/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: null });
  });

  it('401 when a token is present but unknown', async () => {
    const res = await appWithOptionalAuth().request('/probe', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('sets telegramId for a valid token', async () => {
    const res = await appWithOptionalAuth().request('/probe', {
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: 777 });
  });
});
