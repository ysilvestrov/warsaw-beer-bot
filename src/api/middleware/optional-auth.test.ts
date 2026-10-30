import { Hono } from 'hono';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { registerInstall } from '../../storage/extension_installs';
import { optionalAuthMiddleware } from './optional-auth';
import type { ApiEnv } from '../types';

function appWithOptionalAuth() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 777);
  rotateToken(db, 777, hashToken('good-token'), '2026-06-07T00:00:00Z');
  const reg = registerInstall(db, {
    date: '2026-10-29', at: '2026-10-29T09:00:00.000Z', version: '0.23.0', tokenHash: hashToken('wbi_good'),
  }) as { installId: string };
  const app = new Hono<ApiEnv>();
  app.use('/probe', optionalAuthMiddleware(db));
  app.get('/probe', (c) => c.json({ telegramId: c.get('telegramId') ?? null, principal: c.get('principal') ?? null }));
  return { app, db, installId: reg.installId };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('optionalAuthMiddleware', () => {
  it('passes anonymously (no telegramId, no principal) when the Authorization header is missing', async () => {
    const res = await appWithOptionalAuth().app.request('/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: null, principal: null });
  });

  it('401 when a token is present but unknown', async () => {
    const res = await appWithOptionalAuth().app.request('/probe', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('sets telegramId and a user principal for a valid Telegram token', async () => {
    const res = await appWithOptionalAuth().app.request('/probe', {
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: 777, principal: { kind: 'user', telegramId: 777 } });
  });

  it('admits an install token with its principal and no telegramId (#923)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T10:00:00.000Z'));
    const { app, installId } = appWithOptionalAuth();
    const res = await app.request('/probe', { headers: { Authorization: 'Bearer wbi_good' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      telegramId: null,
      principal: { kind: 'install', installId, lastSeenDate: '2026-10-30', extVersion: '0.23.0' },
    });
  });

  it('401 for an unknown install token — it is never looked up among Telegram tokens', async () => {
    const { app, db } = appWithOptionalAuth();
    // A Telegram token whose raw text happens to start with the install prefix still is not an install.
    rotateToken(db, 777, hashToken('wbi_telegram'), '2026-06-08T00:00:00Z');
    const res = await app.request('/probe', { headers: { Authorization: 'Bearer wbi_telegram' } });
    expect(res.status).toBe(401);
  });

  it('records the Warsaw date as last_seen_date, not the UTC one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 23:30 UTC on 30 October is 00:30 on the 31st in Warsaw (CET, UTC+1).
    vi.setSystemTime(new Date('2026-10-30T23:30:00.000Z'));
    const { app, db } = appWithOptionalAuth();
    await app.request('/probe', { headers: { Authorization: 'Bearer wbi_good' } });
    expect(db.prepare('SELECT last_seen_date FROM extension_installs').get()).toEqual({ last_seen_date: '2026-10-31' });
  });

  it('a failed last_seen_date write does not reject a valid install token', async () => {
    const { app, db } = appWithOptionalAuth();
    db.exec(`CREATE TRIGGER no_touch BEFORE UPDATE ON extension_installs BEGIN SELECT RAISE(ABORT, 'busy'); END`);
    const res = await app.request('/probe', { headers: { Authorization: 'Bearer wbi_good' } });
    expect(res.status).toBe(200);
  });
});
