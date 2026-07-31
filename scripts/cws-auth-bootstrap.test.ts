import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuthUrl,
  exchangeCode,
  codeFromArgv,
  resolvePort,
  DEFAULT_PORT,
  writeSecretFile,
} from './cws-auth-bootstrap';

describe('buildAuthUrl', () => {
  it('requests the chromewebstore scope with an offline, forced-consent flow', () => {
    const url = new URL(buildAuthUrl('cid', 'http://127.0.0.1:8976'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8976');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/chromewebstore',
    );
    // Without BOTH of these Google returns no refresh_token on a re-authorisation,
    // which is the only thing this script exists to produce.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('exchangeCode', () => {
  it('exchanges the authorisation code for a refresh token', async () => {
    const calls: { url: string; body: string }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init!.body as string });
      return new Response(JSON.stringify({ refresh_token: '1//rt', access_token: 'ya29' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const rt = await exchangeCode(
      { clientId: 'cid', clientSecret: 'sec', code: 'CODE', redirectUri: 'http://127.0.0.1:8976' },
      impl,
    );
    expect(rt).toBe('1//rt');

    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const sent = new URLSearchParams(calls[0].body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('CODE');
    expect(sent.get('redirect_uri')).toBe('http://127.0.0.1:8976');
  });

  it('fails when Google returns no refresh_token (consent not re-granted)', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ access_token: 'ya29' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    await expect(
      exchangeCode(
        { clientId: 'c', clientSecret: 's', code: 'X', redirectUri: 'http://127.0.0.1:8976' },
        impl,
      ),
    ).rejects.toThrow(/refresh_token/);
  });
});

describe('codeFromArgv', () => {
  it('returns null when --code is absent', () => {
    expect(codeFromArgv(['node', 'script.js', '--verify'])).toBeNull();
  });

  it('returns the value that follows --code', () => {
    expect(codeFromArgv(['node', 'script.js', '--code', '4/0AX...'])).toBe('4/0AX...');
  });

  it('throws when --code is the last token (no value)', () => {
    expect(() => codeFromArgv(['node', 'script.js', '--code'])).toThrow(
      /--code requires a value/,
    );
  });

  it('throws when the token after --code looks like another flag', () => {
    expect(() => codeFromArgv(['node', 'script.js', '--code', '--verify'])).toThrow(
      /--code requires a value/,
    );
  });
});

describe('resolvePort', () => {
  it('defaults to DEFAULT_PORT when CWS_AUTH_PORT is unset', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
  });

  it('parses a numeric CWS_AUTH_PORT', () => {
    expect(resolvePort({ CWS_AUTH_PORT: '9001' })).toBe(9001);
    expect(resolvePort({ CWS_AUTH_PORT: '8080' })).toBe(8080);
  });

  it('throws a clear error on a non-numeric CWS_AUTH_PORT', () => {
    expect(() => resolvePort({ CWS_AUTH_PORT: 'not-a-port' })).toThrow(
      /CWS_AUTH_PORT must be an integer between 1 and 65535/,
    );
  });

  it('throws on an empty CWS_AUTH_PORT instead of silently becoming port 0', () => {
    expect(() => resolvePort({ CWS_AUTH_PORT: '' })).toThrow(
      /CWS_AUTH_PORT must be an integer between 1 and 65535/,
    );
  });

  it('throws on CWS_AUTH_PORT=0 (server.listen(0) would bind a different, unadvertised port)', () => {
    expect(() => resolvePort({ CWS_AUTH_PORT: '0' })).toThrow(
      /CWS_AUTH_PORT must be an integer between 1 and 65535/,
    );
  });

  it('throws on a CWS_AUTH_PORT above the valid TCP port range', () => {
    expect(() => resolvePort({ CWS_AUTH_PORT: '70000' })).toThrow(
      /CWS_AUTH_PORT must be an integer between 1 and 65535/,
    );
  });
});

describe('writeSecretFile', () => {
  it('creates a new file readable only by the owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cws-auth-bootstrap-test-'));
    const path = join(dir, 'cws-env.txt');

    writeSecretFile(path, 'CWS_REFRESH_TOKEN=abc\n');

    expect(readFileSync(path, 'utf8')).toBe('CWS_REFRESH_TOKEN=abc\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions on a pre-existing file left world-readable by a prior run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cws-auth-bootstrap-test-'));
    const path = join(dir, 'cws-env.txt');
    writeFileSync(path, 'stale\n');
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeSecretFile(path, 'CWS_REFRESH_TOKEN=fresh\n');

    expect(readFileSync(path, 'utf8')).toBe('CWS_REFRESH_TOKEN=fresh\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
