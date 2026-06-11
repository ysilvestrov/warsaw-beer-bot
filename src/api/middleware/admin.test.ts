import { Hono } from 'hono';
import type { Env } from '../../config/env';
import type { ApiEnv } from '../types';
import { adminMiddleware } from './admin';

function appWith(token: string | undefined) {
  const app = new Hono<ApiEnv>();
  app.use('/admin/*', adminMiddleware({ ADMIN_API_TOKEN: token } as Env));
  app.get('/admin/ping', (c) => c.json({ ok: true }));
  return app;
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

describe('adminMiddleware', () => {
  it('503 when ADMIN_API_TOKEN is unset', async () => {
    const res = await appWith(undefined).request('/admin/ping');
    expect(res.status).toBe(503);
  });
  it('503 when ADMIN_API_TOKEN is an empty string', async () => {
    const res = await appWith('').request('/admin/ping');
    expect(res.status).toBe(503);
  });
  it('401 with no/!bearer header', async () => {
    const res = await appWith('secret').request('/admin/ping');
    expect(res.status).toBe(401);
  });
  it('401 with a wrong token', async () => {
    const res = await appWith('secret').request('/admin/ping', auth('nope'));
    expect(res.status).toBe(401);
  });
  it('passes through with the correct token', async () => {
    const res = await appWith('secret').request('/admin/ping', auth('secret'));
    expect(res.status).toBe(200);
  });
});
