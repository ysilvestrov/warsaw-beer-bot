import 'dotenv/config';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAccessToken, getItem } from './cws-client';

// One-time helper for #266: turns a Desktop-app OAuth client into a long-lived refresh
// token for the Chrome Web Store API, and can re-verify existing credentials
// (`--verify`) without mutating anything.
//
// Google disabled the out-of-band flow, so this uses a loopback redirect. The port is
// FIXED (not :0) so a manual `--code` re-run reproduces the same redirect_uri, which
// Google checks.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
export const DEFAULT_PORT = 8976;

export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Code exchange failed: HTTP ${res.status} — ${JSON.stringify(body)}`);
  }
  if (typeof body.refresh_token !== 'string') {
    throw new Error(
      'Code exchange returned no refresh_token. Google only issues one when consent is ' +
        're-granted — the auth URL must carry access_type=offline and prompt=consent, ' +
        'and you must complete the consent screen (not silently re-approve).',
    );
  }
  return body.refresh_token;
}

// Waits for Google to redirect the browser back to the loopback listener.
function waitForCode(port: number): Promise<string> {
  return new Promise((res, rej) => {
    const server = createServer((req, reply) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      reply.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      reply.end(code ? 'OK — you can close this tab.' : `Failed: ${error ?? 'no code'}`);
      server.close();
      if (code) res(code);
      else rej(new Error(`Authorisation failed: ${error ?? 'no code in redirect'}`));
    });
    server.on('error', rej);
    server.listen(port, '127.0.0.1');
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

// Read-only credential probe: proves the refresh token works, the Chrome Web Store API
// is enabled, and the account can see this specific item — without touching the item.
async function verify(): Promise<void> {
  const token = await getAccessToken({
    clientId: requireEnv('CWS_CLIENT_ID'),
    clientSecret: requireEnv('CWS_CLIENT_SECRET'),
    refreshToken: requireEnv('CWS_REFRESH_TOKEN'),
  });
  const itemId = process.env.CWS_ITEM_ID ?? 'fdelmnhijeiojadcaihfdpecfcldbndg';
  const item = await getItem(itemId, token);
  console.log(
    `OK — item ${item.id}: draft version ${item.crxVersion ?? '(none)'}, uploadState ${item.uploadState ?? '(none)'}`,
  );
}

async function bootstrap(): Promise<void> {
  const clientId = requireEnv('CWS_CLIENT_ID');
  const clientSecret = requireEnv('CWS_CLIENT_SECRET');
  const port = Number(process.env.CWS_AUTH_PORT ?? DEFAULT_PORT);
  const redirectUri = `http://127.0.0.1:${port}`;
  const url = buildAuthUrl(clientId, redirectUri);

  const tmpDir = resolve(__dirname, '..', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const urlFile = resolve(tmpDir, 'cws-auth-url.txt');
  writeFileSync(urlFile, `${url}\n`);
  console.log(`Open this URL in a browser (also written to ${urlFile}):\n${url}`);

  // Manual fallback for a browser that cannot reach this host's loopback: paste the
  // `code=` value from the failed redirect as `--code <value>`.
  const flagIndex = process.argv.indexOf('--code');
  const code = flagIndex >= 0 ? process.argv[flagIndex + 1] : await waitForCode(port);

  const refreshToken = await exchangeCode({ clientId, clientSecret, code, redirectUri });
  const envFile = resolve(tmpDir, 'cws-env.txt');
  writeFileSync(envFile, `CWS_REFRESH_TOKEN=${refreshToken}\n`);
  console.log(`Refresh token written to ${envFile} — add that line to .env, then run:`);
  console.log('  npm run cws:auth -- --verify');
}

if (require.main === module) {
  const run = process.argv.includes('--verify') ? verify() : bootstrap();
  run.catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
