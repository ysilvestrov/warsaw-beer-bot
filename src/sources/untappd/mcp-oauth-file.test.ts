import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileOAuthProvider, McpLoginRequired, MCP_SCOPE, narrowScope } from './mcp-oauth-file';

const file = () => join(mkdtempSync(join(tmpdir(), 'mcp-oauth-')), 'oauth.json');
const TOKENS = { access_token: 'a1', token_type: 'Bearer', refresh_token: 'r1', expires_in: 3600 };

describe('FileOAuthProvider', () => {
  it('a saved token survives a restart (a new provider on the same file), written 0600 with no tmp left', () => {
    const path = file();
    new FileOAuthProvider(path).saveTokens(TOKENS);
    const reread = new FileOAuthProvider(path);
    expect([reread.tokens(), statSync(path).mode & 0o777, existsSync(`${path}.tmp`)]).toEqual([TOKENS, 0o600, false]);
  });

  it('each save keeps the other fields: a rotated token does not drop the registration or the owner', () => {
    const path = file();
    const p = new FileOAuthProvider(path);
    p.saveClientInformation({ client_id: 'c1' });
    p.saveOwner('ysilvestrov');
    p.saveTokens(TOKENS);
    p.saveTokens({ ...TOKENS, access_token: 'a2', refresh_token: 'r2' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      clientInformation: { client_id: 'c1' }, owner: 'ysilvestrov', tokens: { ...TOKENS, access_token: 'a2', refresh_token: 'r2' },
    });
  });

  it('on the server a login is never started: redirect throws McpLoginRequired', async () => {
    await expect(new FileOAuthProvider(file()).redirectToAuthorization(new URL('https://x/authorize'))).rejects.toBeInstanceOf(McpLoginRequired);
  });

  it('an empty file means no tokens, no owner, and no verifier to finish a login with', () => {
    const p = new FileOAuthProvider(file());
    expect([p.tokens(), p.owner(), p.clientInformation()]).toEqual([undefined, null, undefined]);
    expect(() => p.codeVerifier()).toThrow('no PKCE code verifier saved');
  });
});

describe('narrowScope', () => {
  it('replaces the requested scopes with read-only and keeps the rest of the URL', () => {
    const url = narrowScope(new URL('https://x/authorize?client_id=c1&scope=untappd%3Aread+untappd%3Awrite&state=s'));
    expect([url.searchParams.get('scope'), url.searchParams.get('client_id'), url.searchParams.get('state')]).toEqual([MCP_SCOPE, 'c1', 's']);
  });
});
