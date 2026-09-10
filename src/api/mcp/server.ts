import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiDeps } from '../types';
import type { CatalogCache } from '../../domain/catalog-cache';
import { matchBeersArraySchema } from '../match-input';
import { runMatchTool, renderMatchToolText } from './match-tool';

const TOOL_DESCRIPTION = [
  'Match a list of beers against the Warsaw beer catalog and report, for each one, whether',
  'this user has already drunk it (and how they rated it) plus the beer\'s global rating.',
  '',
  'Split each beer into `brewery` and `name` yourself; both are required. Do not put the',
  'whole title into `name` with an empty `brewery` — a missing brewery pushes the item into',
  'a per-request full-catalog fuzzy-search budget of 20; past that budget only the',
  'catalogue-wide fuzzy stage is skipped for the item (the exact-match stages still ran).',
  '',
  'Statuses: `drunk` (certain), `probably_drunk` (the beer matched only approximately),',
  '`not_drunk` (we hold check-in data for this user and this beer is not in it),',
  '`unknown` (we hold NO drinking data for this user — never report these as undrunk),',
  '`not_in_catalog` (searched, not found), `not_searched` (the catalogue-wide fuzzy search',
  'was skipped for this item due to the budget above — the exact-match stages DID run and',
  'missed, so a miss here is NOT evidence the beer is absent from the catalog).',
  '`confidence: fuzzy` means the matched beer may not be the same beer; say so rather than',
  'reporting its rating as fact.',
].join('\n');

export const MCP_SERVER_NAME = 'warsaw-beer';
export const MCP_SERVER_VERSION = '1.0.0';

export function createMcpServer(
  deps: ApiDeps,
  catalog: CatalogCache,
  telegramId: number,
): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    'match_beers',
    {
      title: 'Match beers against the Warsaw beer catalog',
      description: TOOL_DESCRIPTION,
      inputSchema: { beers: matchBeersArraySchema },
    },
    async ({ beers }) => {
      const { output, fallback } = await runMatchTool(deps.db, catalog, telegramId, beers);
      deps.log.info(
        {
          channel: 'mcp',
          telegramId,
          items: beers.length,
          fullFallback: {
            attempts: fallback.attempts,
            hits: fallback.hits,
            budgetSkipped: fallback.budgetSkipped,
          },
        },
        'match fallback stats',
      );
      return {
        content: [{ type: 'text' as const, text: renderMatchToolText(output) }],
        structuredContent: output as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
