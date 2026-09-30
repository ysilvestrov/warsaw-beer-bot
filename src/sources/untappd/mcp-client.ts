import type pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { FileOAuthProvider, McpLoginRequired } from './mcp-oauth-file';

// The bot's client of the third-party Untappd MCP (spec §4.5). The SDK does discovery, uses the
// stored tokens and refreshes them on a 401; a refresh that fails ends in redirectToAuthorization,
// which on the server throws McpLoginRequired. Connection is lazy and dropped after any failure,
// so the next call starts clean.

export const MCP_CALL_TIMEOUT_MS = 30 * 1000;

export interface ToolCallResult {
  isError?: boolean;
  content?: unknown;
}

export interface FestMcp {
  call(tool: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** Untappd username of the token's owner, as the login script recorded it. */
  owner(): string | null;
  close(): Promise<void>;
}

/** The owner has to log in again: a refresh failed or there were never any tokens. */
export function isMcpAuthError(e: unknown): boolean {
  return e instanceof McpLoginRequired || e instanceof UnauthorizedError;
}

export function createFestMcp(p: { url: string; oauthFile: string; log: pino.Logger }): FestMcp {
  const provider = new FileOAuthProvider(p.oauthFile);
  let client: Client | null = null;

  const drop = async () => {
    const c = client;
    client = null;
    await c?.close().catch(() => {});
  };

  return {
    async call(tool, args) {
      try {
        if (!client) {
          const c = new Client({ name: 'warsaw-beer-bot-fest', version: '1.0.0' });
          await c.connect(new StreamableHTTPClientTransport(new URL(p.url), { authProvider: provider }));
          client = c;
        }
        return (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: MCP_CALL_TIMEOUT_MS })) as ToolCallResult;
      } catch (e) {
        p.log.warn({ tool, auth: isMcpAuthError(e), err: e instanceof Error ? e.message : String(e) }, 'fest mcp call failed');
        await drop();
        throw e;
      }
    },
    owner: () => provider.owner(),
    close: drop,
  };
}
