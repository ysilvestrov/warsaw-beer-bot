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
  app.all('/mcp', async (c) => {
    // Same read as /match (`?? null`): a variable no middleware set reads as undefined
    // at runtime even though the type says `number | null`.
    const telegramId = c.get('telegramId') ?? null;
    // Defensive: authMiddleware already 401s. Keeps the route honest if it is ever
    // mounted without it.
    if (telegramId === null) return c.json({ error: 'unauthorized' }, 401);

    // Stateless: a session lives in process memory, and this process restarts on every
    // deploy — a client holding a session id would get 404 on its next call instead of a
    // transparent reconnect. enableJsonResponse keeps this off SSE: a second long-lived
    // path through cloudflared is exactly what caused the 502s in #124.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(deps, catalog, telegramId);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
