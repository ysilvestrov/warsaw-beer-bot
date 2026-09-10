import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { upsertBeer } from '../../storage/beers';
import { markHad } from '../../storage/untappd_had';
import { mergeCheckin } from '../../storage/checkins';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { createCatalogCache } from '../../domain/catalog-cache';
import { authMiddleware } from '../middleware/auth';
import { mcpRoute } from './mcp';
import type { ApiEnv } from '../types';
// Never hardcode the protocol version: the SDK rejects an unsupported one, and that
// failure would look like a bug in the route rather than a stale constant in the test.
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

// Two users with two DIFFERENT drinking histories, on two DIFFERENT tokens: a route that
// hardcoded telegramId (or shared it across requests) would still pass every test below
// if there were only one user, because the fixture couldn't distinguish "correct" from
// "same wrong answer for everyone" — see review finding 3 on task 4.
function setup() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  ensureProfile(db, 2);
  const panIpani = upsertBeer(db, {
    untappd_id: 9001, name: 'Pan IPAni', brewery: 'Trzech Kumpli',
    style: 'IPA', abv: 6.0, rating_global: 3.85,
    normalized_name: normalizeName('Pan IPAni'),
    normalized_brewery: normalizeBrewery('Trzech Kumpli'),
  });
  const atakChmielu = upsertBeer(db, {
    untappd_id: 9002, name: 'Atak Chmielu', brewery: 'PINTA',
    style: 'IPA', abv: 6.1, rating_global: 3.7,
    normalized_name: normalizeName('Atak Chmielu'),
    normalized_brewery: normalizeBrewery('PINTA'),
  });
  // User 1 has drunk panIpani and nothing else.
  markHad(db, 1, panIpani, '2026-01-05T18:00:00Z');
  // User 2 has a check-in, but on a DIFFERENT beer — panIpani is not in their drunk set,
  // so the same match_beers call must answer differently for the two tokens.
  mergeCheckin(db, {
    checkin_id: 'c1', telegram_id: 2, beer_id: atakChmielu,
    user_rating: 4.5, checkin_at: '2026-02-01T12:00:00Z', venue: null,
  });
  rotateToken(db, 1, hashToken('good-token'), '2026-01-01T00:00:00Z');
  rotateToken(db, 2, hashToken('second-token'), '2026-01-01T00:00:00Z');

  const app = new Hono<ApiEnv>();
  app.use('/mcp', authMiddleware(db));
  mcpRoute(app, { db, env: {} as never, log: pino({ level: 'silent' }) }, createCatalogCache(db));
  return { app, db, panIpani, atakChmielu };
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

  it('serves two consecutive /mcp calls for two different users without leaking one telegramId into the other', async () => {
    // Same app, same beer argument, two different Bearer tokens back to back. If the
    // route ever hardcoded telegramId or reused one request's server/deps for the next,
    // this would either 500 or answer both calls identically — it must not.
    const { app } = setup();
    const args = { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] };

    const first = await rpc(app, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'match_beers', arguments: args },
    }, 'good-token');
    const second = await rpc(app, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'match_beers', arguments: args },
    }, 'second-token');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    type CallBody = {
      result: {
        structuredContent: {
          profile: { checkins_known: number; untappd_had_known: number; drunk_set_empty: boolean };
          results: { status: string; confidence: string }[];
        };
      };
    };
    const b1 = await first.json() as CallBody;
    const b2 = await second.json() as CallBody;

    // User 1 (untappd_had, no checkins): drunk panIpani directly.
    expect(b1.result.structuredContent.results[0].status).toBe('drunk');
    expect(b1.result.structuredContent.profile).toEqual({
      checkins_known: 0, untappd_had_known: 1, latest_checkin_at: null, drunk_set_empty: false,
    });

    // User 2 (a checkin, but on a different beer): panIpani is NOT in their drunk set.
    expect(b2.result.structuredContent.results[0].status).toBe('not_drunk');
    expect(b2.result.structuredContent.profile.checkins_known).toBe(1);
    expect(b2.result.structuredContent.profile.untappd_had_known).toBe(0);
    expect(b2.result.structuredContent.profile.drunk_set_empty).toBe(false);

    // The two responses must differ — a shared/hardcoded telegramId would make them equal.
    expect(b1.result.structuredContent).not.toEqual(b2.result.structuredContent);
  });

  it('rejects GET /mcp with 405 and never opens an SSE stream', async () => {
    // Stateless mode has nothing to push. app.all (instead of app.post) would let a bare
    // GET fall through to the SDK's own long-lived SSE handler — the second long-lived
    // path through cloudflared #124 was about, this time with no close() ever called.
    const { app } = setup();
    const res = await app.request('/mcp', {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer good-token',
      },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    expect(await res.json()).toEqual({ error: 'method_not_allowed' });
  });
});
