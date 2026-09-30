import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

// The bot's side of MCP OAuth 2.1 (spec §4.5): registration, tokens and the PKCE verifier live in
// one JSON file, rewritten atomically on every save — the server may rotate the refresh token, and
// a file cut short by a crash would lock the bot out until someone logs in again. The file holds a
// secret: it is written 0600, and nothing here ever logs its contents.

export const MCP_REDIRECT_URL = 'http://localhost:8765/callback';
/** The bot reads; it must never be able to check in, toast or comment as the owner. */
export const MCP_SCOPE = 'untappd:read';

export class McpLoginRequired extends Error {
  constructor() {
    super('fest MCP needs an interactive login: run scripts/fest-mcp-login.ts');
    this.name = 'McpLoginRequired';
  }
}

interface Stored {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** Untappd username of the account the tokens belong to (set by the login script). */
  owner?: string;
}

export function readOAuthFile(path: string): Stored {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Stored) : {};
}

function writeAtomic(path: string, data: Stored): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600); // mode applies only on create; an old tmp could have kept looser bits
  renameSync(tmp, path);
}

/** The authorization URL with its scope narrowed to read-only (the SDK asks for every supported scope). */
export function narrowScope(url: URL): URL {
  const out = new URL(url);
  out.searchParams.set('scope', MCP_SCOPE);
  return out;
}

export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly path: string,
    /** The server passes none: it must not start a login, only report that one is needed. */
    private readonly onAuthorize: (url: URL) => void | Promise<void> = () => { throw new McpLoginRequired(); },
  ) {}

  get redirectUrl(): string {
    return MCP_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'warsaw-beer-bot fest',
      redirect_uris: [MCP_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: MCP_SCOPE,
    };
  }

  private update(patch: Partial<Stored>): void {
    writeAtomic(this.path, { ...readOAuthFile(this.path), ...patch });
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readOAuthFile(this.path).clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.update({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return readOAuthFile(this.path).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.update({ tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.onAuthorize(narrowScope(url));
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.update({ codeVerifier });
  }

  codeVerifier(): string {
    const v = readOAuthFile(this.path).codeVerifier;
    if (!v) throw new Error('no PKCE code verifier saved');
    return v;
  }

  owner(): string | null {
    return readOAuthFile(this.path).owner ?? null;
  }

  saveOwner(owner: string): void {
    this.update({ owner });
  }
}
