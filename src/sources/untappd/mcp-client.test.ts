import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { isMcpAuthError } from './mcp-client';
import { McpLoginRequired } from './mcp-oauth-file';

describe('isMcpAuthError', () => {
  it('a missing login and a rejected token need the owner; a network error does not', () => {
    expect([new McpLoginRequired(), new UnauthorizedError('401'), new Error('fetch failed'), 'x'].map(isMcpAuthError))
      .toEqual([true, true, false, false]);
  });
});
