import type { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport }
  from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ApiDeps, ApiEnv } from '../types';
import type { CatalogCache } from '../../domain/catalog-cache';
import { createMcpServer } from '../mcp/server';

// Registers the MCP endpoint. Unlike /match, auth is mandatory (authMiddleware runs in
// createApiApp): an anonymous answer would report is_drunk=false on every beer, and an
// agent retells that as "you have not drunk any of these" — plausible and wrong.
export function mcpRoute(app: Hono<ApiEnv>, deps: ApiDeps, catalog: CatalogCache): void {
  app.post('/mcp', async (c) => {
    // Same read as /match (`?? null`): a variable no middleware set reads as undefined
    // at runtime even though the type says `number | null`.
    const telegramId = c.get('telegramId') ?? null;
    // Defensive: authMiddleware already 401s. Keeps the route honest if it is ever
    // mounted without it.
    if (telegramId === null) return c.json({ error: 'unauthorized' }, 401);

    // Stateless: a session lives in process memory, and this process restarts on every
    // deploy — a client holding a session id would get 404 on its next call instead of a
    // transparent reconnect. enableJsonResponse keeps POST replies off SSE.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(deps, catalog, telegramId);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  // POST-only, not app.all: in stateless mode the SDK's own `validateSession` returns
  // undefined for every method, so a bare GET (which MCP clients probe routinely) would
  // fall through to the SDK's `handleGetRequest` and open a long-lived SSE stream with a
  // default-on keep-alive `setInterval` — nothing here ever calls close() on it, so a
  // tunnel-dropped stream leaks that timer plus the closure holding telegramId/deps. That
  // is exactly the second long-lived path through cloudflared #124 was about.
  // `enableJsonResponse` governs POST replies only; it does not gate GET. This server has
  // nothing to push, so refuse the stream outright rather than opening one.
  app.all('/mcp', (c) => c.json({ error: 'method_not_allowed' }, 405));
}
