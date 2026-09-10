import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { upsertBeer } from '../../storage/beers';
import { markHad } from '../../storage/untappd_had';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { createCatalogCache } from '../../domain/catalog-cache';
import { authMiddleware } from '../middleware/auth';
import { mcpRoute } from './mcp';
import type { ApiEnv } from '../types';
// Never hardcode the protocol version: the SDK rejects an unsupported one, and that
// failure would look like a bug in the route rather than a stale constant in the test.
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  const panIpani = upsertBeer(db, {
    untappd_id: 9001, name: 'Pan IPAni', brewery: 'Trzech Kumpli',
    style: 'IPA', abv: 6.0, rating_global: 3.85,
    normalized_name: normalizeName('Pan IPAni'),
    normalized_brewery: normalizeBrewery('Trzech Kumpli'),
  });
  markHad(db, 1, panIpani, '2026-01-05T18:00:00Z');
  rotateToken(db, 1, hashToken('good-token'), '2026-01-01T00:00:00Z');

  const app = new Hono<ApiEnv>();
  app.use('/mcp', authMiddleware(db));
  mcpRoute(app, { db, env: {} as never, log: pino({ level: 'silent' }) }, createCatalogCache(db));
  return { app, db, panIpani };
}

function rpc(app: Hono<ApiEnv>, body: unknown, token: string | null = 'good-token') {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return app.request('/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};

describe('POST /mcp', () => {
  it('completes the initialize handshake', async () => {
    const { app } = setup();
    const res = await rpc(app, INIT);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('warsaw-beer');
  });

  it('lists exactly one tool, match_beers', async () => {
    const { app } = setup();
    await rpc(app, INIT);
    const res = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const body = await res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(['match_beers']);
  });

  it('calls match_beers and returns structured results', async () => {
    const { app } = setup();
    await rpc(app, INIT);
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'match_beers', arguments: { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] } },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      result: { structuredContent: { results: { status: string; confidence: string }[] };
                content: { type: string; text: string }[] };
    };
    expect(body.result.structuredContent.results[0].status).toBe('drunk');
    expect(body.result.structuredContent.results[0].confidence).toBe('exact');
    // A text mirror must be present for clients that render only text.
    expect(body.result.content[0].text).toContain('Pan IPAni');
  });

  it('rejects a request with no token', async () => {
    const { app } = setup();
    const res = await rpc(app, INIT, null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a request with an unknown token', async () => {
    const { app } = setup();
    const res = await rpc(app, INIT, 'not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('serves two consecutive calls on the same app (the per-request server is not shared state)', async () => {
    const { app } = setup();
    await rpc(app, INIT);
    const first = await rpc(app, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    const second = await rpc(app, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const b2 = await second.json() as { result: { tools: { name: string }[] } };
    expect(b2.result.tools).toHaveLength(1);
  });
});
