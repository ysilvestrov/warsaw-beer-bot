import { Hono } from 'hono';
import { z } from 'zod';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import type { ApiDeps, ApiEnv } from '../types';
import {
  payloadBodyLimit,
  payloadSizeValidationHook,
} from './payload-limit';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 555);
  rotateToken(db, 555, hashToken('tok'), '2026-07-12T00:00:00Z');
  const warn = vi.fn();
  const deps = { db, env: {} as never, log: { warn } as never } satisfies ApiDeps;
  const app = new Hono<ApiEnv>();
  app.use('/upload', payloadBodyLimit(deps, 5, 'route'));
  app.post('/upload', async (c) => c.json({ body: await c.req.text() }));
  return { app, deps, warn };
}

describe('payloadBodyLimit', () => {
  it('rejects a declared oversized body with a structured 413 warning', async () => {
    const { app, warn } = setup();
    const res = await app.request('/upload?source=test', {
      method: 'POST',
      headers: { 'Content-Length': '6' },
      body: 'secret-body-value',
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn).toHaveBeenCalledWith(
      {
        method: 'POST', path: '/upload', rejectionLayer: 'route', limit: 5,
        limitUnit: 'bytes', contentLength: 6, auth: 'anonymous',
      },
      'api payload too large',
    );
  });

  it('stops a streamed body without Content-Length', async () => {
    const { app, warn } = setup();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('123'));
        if (pulls === 10) controller.close();
      },
    });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
    const req = new Request('http://localhost/upload', init);
    const res = await app.request(req);

    expect(res.status).toBe(413);
    expect(pulls).toBeLessThan(10);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ contentLength: null });
  });

  it.each([
    ['missing', undefined, 'anonymous', undefined],
    ['valid', 'Bearer tok', 'authenticated', 555],
    ['invalid token', 'Bearer nope', 'invalid', undefined],
    ['malformed', 'Basic tok', 'invalid', undefined],
  ])('classifies %s authorization safely', async (_name, authorization, auth, telegramId) => {
    const { app, warn } = setup();
    const headers: Record<string, string> = { 'Content-Length': '6' };
    if (authorization) headers.Authorization = authorization;
    await app.request('/upload', { method: 'POST', headers, body: 'private-body-value' });

    const fields = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields.auth).toBe(auth);
    expect(fields.telegramId).toBe(telegramId);
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain('tok');
    expect(serialized).not.toContain(hashToken(authorization?.replace('Bearer ', '') ?? ''));
    expect(serialized).not.toContain('private-body-value');
  });

  it('prefers an authenticated identity already stored on context', async () => {
    const { deps, warn } = setup();
    const app = new Hono<ApiEnv>();
    app.use('/upload', async (c, next) => { c.set('telegramId', 777); await next(); });
    app.use('/upload', payloadBodyLimit(deps, 5, 'global'));
    app.post('/upload', (c) => c.text('unreachable'));
    await app.request('/upload', {
      method: 'POST', headers: { 'Content-Length': '6', Authorization: 'Bearer nope' }, body: 'secret',
    });
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ auth: 'authenticated', telegramId: 777 });
  });

  it('preserves the 413 response when rejection identity lookup fails', async () => {
    const { app, deps, warn } = setup();
    deps.db.close();

    const res = await app.request('/upload', {
      method: 'POST',
      headers: { 'Content-Length': '6', Authorization: 'Bearer tok' },
      body: 'secret',
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'invalid' }),
      'api payload too large',
    );
    expect((warn.mock.calls[0]?.[0] as Record<string, unknown>).telegramId).toBeUndefined();
  });
});

describe('payloadSizeValidationHook', () => {
  it('returns and logs a schema 413 for the first oversized string field', async () => {
    const { deps, warn } = setup();
    const schema = z.object({ nested: z.object({ html: z.string().max(4) }) });
    const result = schema.safeParse({ nested: { html: 'sensitive-html' } });
    const app = new Hono<ApiEnv>();
    app.post('/validate', (c) => payloadSizeValidationHook(deps)(result, c) ?? c.text('next'));
    const res = await app.request('/validate', { method: 'POST', headers: { Authorization: 'Bearer tok' } });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(warn).toHaveBeenCalledWith(
      {
        method: 'POST', path: '/validate', rejectionLayer: 'schema', limit: 4,
        limitUnit: 'characters', contentLength: null, auth: 'authenticated',
        telegramId: 555, fieldPath: 'nested.html',
      },
      'api payload too large',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-html');
  });

  it('returns undefined for non-size validation failures', async () => {
    const { deps } = setup();
    const result = z.object({ html: z.string() }).safeParse({});
    const app = new Hono<ApiEnv>();
    let value: unknown;
    app.get('/', (c) => { value = payloadSizeValidationHook(deps)(result, c); return c.text('ok'); });
    await app.request('/');
    expect(value).toBeUndefined();
  });
});
