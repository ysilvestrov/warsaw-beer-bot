import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createFestMcp, isMcpAuthError } from './mcp-client';
import { McpLoginRequired } from './mcp-oauth-file';

describe('isMcpAuthError', () => {
  it('a missing login and a rejected token need the owner; a network error does not', () => {
    expect([new McpLoginRequired(), new UnauthorizedError('401'), new Error('fetch failed'), 'x'].map(isMcpAuthError))
      .toEqual([true, true, false, false]);
  });
});

describe('createFestMcp', () => {
  let server: Server;
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('a server that accepts the connection and never answers fails the call after the timeout, not never', async () => {
    const held: import('node:http').ServerResponse[] = [];
    server = createServer((_req, res) => { held.push(res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const mcp = createFestMcp({
      url: `http://127.0.0.1:${port}/mcp`, oauthFile: join(mkdtempSync(join(tmpdir(), 'mcp-')), 'o.json'),
      log: pino({ level: 'silent' }), timeoutMs: 100,
    });
    await expect(mcp.call('get_untappd_api_usage', {})).rejects.toThrow('mcp connect timed out after 100 ms');
    for (const res of held) res.destroy();
  });
});
