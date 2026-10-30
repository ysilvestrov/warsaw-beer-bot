import { Hono } from 'hono';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { registerInstall } from '../../storage/extension_installs';
import { authMiddleware } from './auth';
import type { ApiEnv } from '../types';

function appWithAuth() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 777);
  rotateToken(db, 777, hashToken('good-token'), '2026-06-07T00:00:00Z');
  registerInstall(db, { date: '2026-10-30', at: '2026-10-30T09:00:00.000Z', version: '1', tokenHash: hashToken('wbi_good') });
  const app = new Hono<ApiEnv>();
  app.use('/secure', authMiddleware(db));
  app.get('/secure', (c) => c.json({ telegramId: c.get('telegramId') }));
  return app;
}

describe('authMiddleware', () => {
  it('401 when Authorization header is missing', async () => {
    const res = await appWithAuth().request('/secure');
    expect(res.status).toBe(401);
  });

  it('401 when the token is unknown', async () => {
    const res = await appWithAuth().request('/secure', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('403 install_token_not_allowed for a valid install token (#923)', async () => {
    const app = appWithAuth();
    const res = await app.request('/secure', { headers: { Authorization: 'Bearer wbi_good' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'install_token_not_allowed' });
  });

  it('401, not 403, for an unknown install token', async () => {
    const res = await appWithAuth().request('/secure', { headers: { Authorization: 'Bearer wbi_unknown' } });
    expect(res.status).toBe(401);
  });

  it('passes and sets telegramId for a valid token', async () => {
    const res = await appWithAuth().request('/secure', {
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: 777 });
  });
});
