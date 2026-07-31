# CWS Store Upload Automation Implementation Plan (#266)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run release:store` builds the Chrome Web Store package, uploads it to the live store item and submits it for review, with failures reported loudly.

**Architecture:** A hand-written Chrome Web Store API client on the platform `fetch` (`scripts/cws-client.ts`, four pure functions with an injected `fetch`), an orchestrator modelled on `scripts/publish-extension-release.ts` (`scripts/publish-store-release.ts`), and a one-time OAuth bootstrap helper (`scripts/cws-auth-bootstrap.ts`). Credentials live in the repo-root `.env`. The store zip gets its own filename so it can never overwrite the off-store dev zip.

**Tech Stack:** TypeScript (CommonJS, root tsconfig), tsx, Vitest (root config already includes `scripts/**/*.test.ts`), dotenv, Node's global `fetch`, Python 3 (`extension/scripts/zip-dist.py`).

**Spec:** `docs/superpowers/specs/2026-07/2026-07-31-cws-upload-automation-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/cws-client.ts` (create) | Four pure API functions: `getAccessToken`, `getItem`, `uploadPackage`, `publishItem`. No env, no filesystem, injected `fetch`. |
| `scripts/cws-client.test.ts` (create) | Unit tests for the client with a fake `fetch`. No network. |
| `scripts/cws-auth-bootstrap.ts` (create) | One-time OAuth dance: build the auth URL, catch the loopback `code`, exchange it for a refresh token. Also `--verify` (live read-only probe). |
| `scripts/cws-auth-bootstrap.test.ts` (create) | Unit tests for `buildAuthUrl` / `exchangeCode`. |
| `scripts/publish-store-release.ts` (create) | Orchestrator: env → preflight → upload → publish. Supports `--dry-run`. |
| `scripts/publish-store-release.test.ts` (create) | Unit tests for env reading, zip path, preflight abort, dry-run. |
| `extension/scripts/zip-dist.py` (modify) | Store builds (`CWS_BUILD=1`) write `…-store.zip` instead of overwriting the dev zip. |
| `extension/src/build/zip-determinism.test.ts` (modify) | Add a test pinning the store-build filename. |
| `package.json` (modify) | `release:store` and `cws:auth` scripts. |
| `spec.md`, `docs/cws-listing.md`, `docs/extension-release.md` (modify) | Documentation. |

**Ordering rule (project policy `feedback_validate_external_apis_first`):** Tasks 1–3 build only the *read-only* half of the client plus the credential bootstrap. Task 4 is a hard gate — a live authenticated call must succeed before Tasks 5+ (upload/publish) are written.

---

### Task 1: Access-token refresh (`getAccessToken`)

**Files:**
- Create: `scripts/cws-client.ts`
- Create: `scripts/cws-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/cws-client.test.ts`:

```ts
import { getAccessToken } from './cws-client';

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CREDS = { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt' };

describe('getAccessToken', () => {
  it('posts the refresh_token grant and returns the access token', async () => {
    const { impl, calls } = fakeFetch({ access_token: 'ya29.token' });
    expect(await getAccessToken(CREDS, impl)).toBe('ya29.token');

    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].init!.method).toBe('POST');
    const sent = new URLSearchParams(calls[0].init!.body as string);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('client_id')).toBe('cid');
    expect(sent.get('client_secret')).toBe('secret');
    expect(sent.get('refresh_token')).toBe('rt');
  });

  it('turns invalid_grant into an actionable message naming the Testing-mode trap', async () => {
    const { impl } = fakeFetch({ error: 'invalid_grant' }, 400);
    await expect(getAccessToken(CREDS, impl)).rejects.toThrow(/invalid_grant/);
    await expect(getAccessToken(CREDS, impl)).rejects.toThrow(/Testing/);
    await expect(getAccessToken(CREDS, impl)).rejects.toThrow(/cws-auth-bootstrap/);
  });

  it('fails loudly on any other error response', async () => {
    const { impl } = fakeFetch({ error: 'invalid_client' }, 401);
    await expect(getAccessToken(CREDS, impl)).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/cws-client.test.ts`
Expected: FAIL — "Failed to resolve import ./cws-client".

- [ ] **Step 3: Write the implementation**

Create `scripts/cws-client.ts`:

```ts
// Thin Chrome Web Store API client (#266). Three endpoints, no dependency: the API has
// been stable for years and the whole risk here is INTERPRETING its replies — both
// upload and publish report failure inside an HTTP 200 body, so a generic wrapper would
// call a failed release a success.
//
// Every function takes `fetchImpl` (same seam as src/sources/websearch/resolver.ts) so
// the tests never touch the network.

export interface CwsCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface TokenResponse {
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export async function getAccessToken(
  creds: CwsCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;

  if (body.error === 'invalid_grant') {
    throw new Error(
      'CWS auth failed: invalid_grant — the refresh token is dead. Either access was ' +
        'revoked, or the OAuth consent screen is still in "Testing" mode, where Google ' +
        'expires refresh tokens after 7 days (move it to "In production"). Re-run: ' +
        'npm run cws:auth',
    );
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    const detail = [body.error, body.error_description].filter(Boolean).join(': ');
    throw new Error(`CWS auth failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return body.access_token;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/cws-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cws-client.ts scripts/cws-client.test.ts
git commit -m "feat(#266): CWS access-token refresh with an actionable invalid_grant message"
```

---

### Task 2: Read the item (`getItem`)

**Files:**
- Modify: `scripts/cws-client.ts`
- Modify: `scripts/cws-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/cws-client.test.ts`:

```ts
import { getItem } from './cws-client';

describe('getItem', () => {
  it('reads the DRAFT projection and returns the draft version', async () => {
    const { impl, calls } = fakeFetch({
      kind: 'chromewebstore#item',
      id: 'fdelmnhijeiojadcaihfdpecfcldbndg',
      uploadState: 'SUCCESS',
      crxVersion: '0.12.0',
    });

    const item = await getItem('fdelmnhijeiojadcaihfdpecfcldbndg', 'tok', impl);
    expect(item).toEqual({
      id: 'fdelmnhijeiojadcaihfdpecfcldbndg',
      crxVersion: '0.12.0',
      uploadState: 'SUCCESS',
    });

    expect(calls[0].url).toBe(
      'https://www.googleapis.com/chromewebstore/v1.1/items/fdelmnhijeiojadcaihfdpecfcldbndg?projection=DRAFT',
    );
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['x-goog-api-version']).toBe('2');
  });

  it('reports a missing crxVersion as null rather than inventing one', async () => {
    const { impl } = fakeFetch({ id: 'abc', uploadState: 'SUCCESS' });
    expect((await getItem('abc', 'tok', impl)).crxVersion).toBeNull();
  });

  it('throws on a non-2xx response', async () => {
    const { impl } = fakeFetch({ error: { message: 'no access' } }, 403);
    await expect(getItem('abc', 'tok', impl)).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/cws-client.test.ts`
Expected: FAIL — `getItem is not a function` / import error.

- [ ] **Step 3: Write the implementation**

Append to `scripts/cws-client.ts`:

```ts
const API_BASE = 'https://www.googleapis.com/chromewebstore/v1.1/items';

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' };
}

export interface CwsItem {
  id: string;
  crxVersion: string | null;
  uploadState: string | null;
}

// Read-only. Used both as the credential probe (`cws:auth --verify`) and as the release
// preflight: `crxVersion` is the version currently sitting in the item's draft.
export async function getItem(
  itemId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CwsItem> {
  const res = await fetchImpl(`${API_BASE}/${itemId}?projection=DRAFT`, {
    headers: authHeaders(token),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`CWS getItem failed: HTTP ${res.status} — ${JSON.stringify(body)}`);
  }
  return {
    id: typeof body.id === 'string' ? body.id : itemId,
    crxVersion: typeof body.crxVersion === 'string' ? body.crxVersion : null,
    uploadState: typeof body.uploadState === 'string' ? body.uploadState : null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/cws-client.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cws-client.ts scripts/cws-client.test.ts
git commit -m "feat(#266): read the CWS draft item (probe + release preflight)"
```

---

### Task 3: One-time OAuth bootstrap

**Files:**
- Create: `scripts/cws-auth-bootstrap.ts`
- Create: `scripts/cws-auth-bootstrap.test.ts`
- Modify: `package.json` (add the `cws:auth` script)

- [ ] **Step 1: Write the failing tests**

Create `scripts/cws-auth-bootstrap.test.ts`:

```ts
import { buildAuthUrl, exchangeCode } from './cws-auth-bootstrap';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/cws-auth-bootstrap.test.ts`
Expected: FAIL — cannot resolve `./cws-auth-bootstrap`.

- [ ] **Step 3: Write the implementation**

Create `scripts/cws-auth-bootstrap.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/cws-auth-bootstrap.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the npm script**

In the root `package.json`, inside `"scripts"`, after `"render-docs"`:

```json
"cws:auth": "tsx scripts/cws-auth-bootstrap.ts",
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/cws-auth-bootstrap.ts scripts/cws-auth-bootstrap.test.ts package.json
git commit -m "feat(#266): one-time CWS OAuth bootstrap + read-only credential probe"
```

---

### Task 4: GATE — obtain credentials and prove the API works

**This task is performed by the maintainer in a browser. No further code is written until its final step prints `OK`.** This enforces the project policy `feedback_validate_external_apis_first`: a live authenticated call must succeed before integration code exists.

**Files:**
- Modify: `.env` (never committed)

- [ ] **Step 1: Google Cloud setup (browser)**

  1. Create or pick a Google Cloud project under the account that owns the CWS item.
  2. APIs & Services → Library → enable **Chrome Web Store API**.
  3. OAuth consent screen → **External**, then **Publish app** so its status is **In production**. While it is in *Testing*, Google expires refresh tokens after 7 days and the automation dies silently between releases.
  4. Credentials → Create credentials → OAuth client ID → application type **Desktop app**. Copy the client ID and client secret.

- [ ] **Step 2: Put the client credentials into `.env`**

Add to the repo-root `.env`:

```
CWS_CLIENT_ID=<client id>
CWS_CLIENT_SECRET=<client secret>
CWS_ITEM_ID=fdelmnhijeiojadcaihfdpecfcldbndg
```

- [ ] **Step 3: Run the bootstrap**

Run: `npm run cws:auth`
Expected: it prints an auth URL (also at `./tmp/cws-auth-url.txt`) and waits. Open the
URL, grant access. On success it writes `./tmp/cws-env.txt` containing
`CWS_REFRESH_TOKEN=…`.

If the browser cannot reach `http://127.0.0.1:8976` (browser on another machine), the
redirect will fail to load — copy the `code=` value out of the address bar and re-run:
`npm run cws:auth -- --code <value>`.

- [ ] **Step 4: Add the refresh token to `.env`**

Append the `CWS_REFRESH_TOKEN=…` line from `./tmp/cws-env.txt` to `.env`.

- [ ] **Step 5: Run the live probe — THE GATE**

Run: `npm run cws:auth -- --verify`
Expected: `OK — item fdelmnhijeiojadcaihfdpecfcldbndg: draft version 0.12.0, uploadState SUCCESS`
(the draft version may differ; any `OK` line counts).

If this fails, stop and fix the credentials. Do not start Task 5.

---

### Task 5: Upload the package (`uploadPackage`)

**Files:**
- Modify: `scripts/cws-client.ts`
- Modify: `scripts/cws-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/cws-client.test.ts`:

```ts
import { uploadPackage } from './cws-client';

describe('uploadPackage', () => {
  it('PUTs the zip bytes to the upload endpoint', async () => {
    const { impl, calls } = fakeFetch({ uploadState: 'SUCCESS' });
    const zip = Buffer.from('PKfake');
    await uploadPackage('itemid', zip, 'tok', impl);

    expect(calls[0].url).toBe(
      'https://www.googleapis.com/upload/chromewebstore/v1.1/items/itemid',
    );
    expect(calls[0].init!.method).toBe('PUT');
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['x-goog-api-version']).toBe('2');
    expect(calls[0].init!.body).toBe(zip);
  });

  // The reason this client exists: CWS reports upload failures with HTTP 200.
  it('treats uploadState FAILURE as an error and surfaces every itemError detail', async () => {
    const { impl } = fakeFetch({
      uploadState: 'FAILURE',
      itemError: [
        {
          error_code: 'PKG_INVALID_VERSION_NUMBER',
          error_detail: 'Version number is invalid or too small.',
        },
      ],
    });
    const p = uploadPackage('itemid', Buffer.from('x'), 'tok', impl);
    await expect(p).rejects.toThrow(/PKG_INVALID_VERSION_NUMBER/);
    await expect(uploadPackage('itemid', Buffer.from('x'), 'tok', impl)).rejects.toThrow(
      /Version number is invalid or too small\./,
    );
  });

  it('treats IN_PROGRESS as not-success rather than silently passing', async () => {
    const { impl } = fakeFetch({ uploadState: 'IN_PROGRESS' });
    await expect(uploadPackage('itemid', Buffer.from('x'), 'tok', impl)).rejects.toThrow(
      /IN_PROGRESS/,
    );
  });

  it('throws on a transport-level error too', async () => {
    const { impl } = fakeFetch({ error: { message: 'nope' } }, 500);
    await expect(uploadPackage('itemid', Buffer.from('x'), 'tok', impl)).rejects.toThrow(
      /500/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/cws-client.test.ts`
Expected: FAIL — `uploadPackage is not a function` / import error.

- [ ] **Step 3: Write the implementation**

Append to `scripts/cws-client.ts`:

```ts
const UPLOAD_BASE = 'https://www.googleapis.com/upload/chromewebstore/v1.1/items';

interface ItemError {
  error_code?: unknown;
  error_detail?: unknown;
}

// HTTP 200 does NOT mean the upload worked: CWS reports failure in the body via
// uploadState + itemError[]. Only "SUCCESS" counts.
export async function uploadPackage(
  itemId: string,
  zip: Buffer,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${UPLOAD_BASE}/${itemId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: zip,
  });
  const body = (await res.json().catch(() => ({}))) as {
    uploadState?: unknown;
    itemError?: unknown;
  };
  if (!res.ok) {
    throw new Error(`CWS upload failed: HTTP ${res.status} — ${JSON.stringify(body)}`);
  }
  if (body.uploadState !== 'SUCCESS') {
    const errors = Array.isArray(body.itemError) ? (body.itemError as ItemError[]) : [];
    const detail = errors
      .map((e) => `${String(e.error_code ?? '?')}: ${String(e.error_detail ?? '?')}`)
      .join('; ');
    throw new Error(
      `CWS upload failed (uploadState=${String(body.uploadState)})` +
        (detail ? ` — ${detail}` : ''),
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/cws-client.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cws-client.ts scripts/cws-client.test.ts
git commit -m "feat(#266): upload the store package, failing on uploadState != SUCCESS"
```

---

### Task 6: Submit for review (`publishItem`)

**Files:**
- Modify: `scripts/cws-client.ts`
- Modify: `scripts/cws-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/cws-client.test.ts`:

```ts
import { publishItem } from './cws-client';

describe('publishItem', () => {
  it('POSTs to the default publish target and returns the status list', async () => {
    const { impl, calls } = fakeFetch({ status: ['OK'], statusDetail: ['ok'] });
    expect(await publishItem('itemid', 'tok', impl)).toEqual(['OK']);

    expect(calls[0].url).toBe(
      'https://www.googleapis.com/chromewebstore/v1.1/items/itemid/publish?publishTarget=default',
    );
    expect(calls[0].init!.method).toBe('POST');
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('fails on ITEM_NOT_UPDATABLE and quotes the statusDetail', async () => {
    const { impl } = fakeFetch({
      status: ['ITEM_NOT_UPDATABLE'],
      statusDetail: ['Item is currently in the review queue.'],
    });
    const p = publishItem('itemid', 'tok', impl);
    await expect(p).rejects.toThrow(/ITEM_NOT_UPDATABLE/);
    await expect(publishItem('itemid', 'tok', impl)).rejects.toThrow(/review queue/);
  });

  it('fails when the response carries no status at all', async () => {
    const { impl } = fakeFetch({});
    await expect(publishItem('itemid', 'tok', impl)).rejects.toThrow(/no status/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/cws-client.test.ts`
Expected: FAIL — `publishItem is not a function` / import error.

- [ ] **Step 3: Write the implementation**

Append to `scripts/cws-client.ts`:

```ts
// publishTarget=default → the public listing (the alternative, trustedTesters, is not
// used by this project). Like upload, failure arrives inside an HTTP 200 body.
export async function publishItem(
  itemId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchImpl(`${API_BASE}/${itemId}/publish?publishTarget=default`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-length': '0' },
  });
  const body = (await res.json().catch(() => ({}))) as {
    status?: unknown;
    statusDetail?: unknown;
  };
  if (!res.ok) {
    throw new Error(`CWS publish failed: HTTP ${res.status} — ${JSON.stringify(body)}`);
  }
  const status = Array.isArray(body.status) ? body.status.map(String) : [];
  if (!status.includes('OK')) {
    const detail = Array.isArray(body.statusDetail)
      ? body.statusDetail.map(String).join('; ')
      : '';
    throw new Error(
      `CWS publish failed (${status.join(', ') || 'no status'})` + (detail ? ` — ${detail}` : ''),
    );
  }
  return status;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/cws-client.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cws-client.ts scripts/cws-client.test.ts
git commit -m "feat(#266): submit the uploaded version for review"
```

---

### Task 7: Store zip gets its own filename

**Files:**
- Modify: `extension/scripts/zip-dist.py:24-26`
- Modify: `extension/src/build/zip-determinism.test.ts`

Why: `package` and `package:store` currently both write
`extension/warsaw-beer-overlay-<version>.zip`, so a store build silently overwrites the
dev zip whose sha256 is already recorded in `extension_releases`.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/build/zip-determinism.test.ts`:

```ts
import { existsSync, rmSync } from 'node:fs';

describe('zip-dist naming', () => {
  it('gives the store build its own filename so it cannot overwrite the dev zip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zipname-'));
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'alpha');

    const extRoot = resolve(here, '..', '..');
    const version = JSON.parse(
      readFileSync(join(extRoot, 'package.json'), 'utf8'),
    ).version as string;
    const storeZip = join(extRoot, `warsaw-beer-overlay-${version}-store.zip`);
    rmSync(storeZip, { force: true });

    // No ZIP_DIST_OUT: this exercises the DEFAULT output path the npm scripts rely on.
    execFileSync('python3', [script], {
      env: { ...process.env, ZIP_DIST_SRC: src, CWS_BUILD: '1' },
    });

    expect(existsSync(storeZip)).toBe(true);
    rmSync(storeZip, { force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix extension exec vitest run src/build/zip-determinism.test.ts`
Expected: FAIL — the store-suffixed zip does not exist (the script wrote the plain name).

- [ ] **Step 3: Change the default output name**

In `extension/scripts/zip-dist.py`, replace lines 23–26:

```python
DIST = os.environ.get("ZIP_DIST_SRC", os.path.join(EXT_ROOT, "dist"))
# The store build (CWS_BUILD=1) is a DIFFERENT artefact from the dev build (no `key`,
# no broad optional host permission), so it gets its own filename — otherwise it would
# silently overwrite the dev zip whose sha256 is already in `extension_releases`.
SUFFIX = "-store" if os.environ.get("CWS_BUILD") == "1" else ""
OUT = os.environ.get(
    "ZIP_DIST_OUT", os.path.join(EXT_ROOT, f"warsaw-beer-overlay-{VERSION}{SUFFIX}.zip")
)
```

- [ ] **Step 4: Run the extension test suite**

Run: `npm --prefix extension exec vitest run src/build/zip-determinism.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/scripts/zip-dist.py extension/src/build/zip-determinism.test.ts
git commit -m "fix(#266): store build writes its own zip instead of overwriting the dev one"
```

---

### Task 8: Release orchestrator — env, zip path, preflight, dry-run

**Files:**
- Create: `scripts/publish-store-release.ts`
- Create: `scripts/publish-store-release.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/publish-store-release.test.ts`:

```ts
import {
  readStoreEnv,
  storeZipPath,
  runRelease,
  DEFAULT_ITEM_ID,
  type ReleaseDeps,
} from './publish-store-release';

const ENV = {
  CWS_CLIENT_ID: 'cid',
  CWS_CLIENT_SECRET: 'sec',
  CWS_REFRESH_TOKEN: 'rt',
};

function deps(overrides: Partial<ReleaseDeps> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      getAccessToken: async () => {
        calls.push('token');
        return 'tok';
      },
      getItem: async () => {
        calls.push('getItem');
        return { id: DEFAULT_ITEM_ID, crxVersion: '0.12.0', uploadState: 'SUCCESS' };
      },
      uploadPackage: async () => {
        calls.push('upload');
      },
      publishItem: async () => {
        calls.push('publish');
        return ['OK'];
      },
      readZip: () => {
        calls.push('readZip');
        return Buffer.from('zip');
      },
      ...overrides,
    },
  };
}

describe('readStoreEnv', () => {
  it('names the missing variable', () => {
    expect(() => readStoreEnv({ ...ENV, CWS_REFRESH_TOKEN: undefined })).toThrow(
      /CWS_REFRESH_TOKEN/,
    );
  });

  it('defaults the item id to the published extension', () => {
    expect(readStoreEnv(ENV).itemId).toBe(DEFAULT_ITEM_ID);
  });

  it('lets CWS_ITEM_ID override the default', () => {
    expect(readStoreEnv({ ...ENV, CWS_ITEM_ID: 'other' }).itemId).toBe('other');
  });
});

describe('storeZipPath', () => {
  it('points at the store-suffixed artefact, not the dev zip', () => {
    expect(storeZipPath('/repo/extension', '0.13.0')).toBe(
      '/repo/extension/warsaw-beer-overlay-0.13.0-store.zip',
    );
  });
});

describe('runRelease', () => {
  it('aborts before uploading when the draft already carries this version', async () => {
    const { calls, deps: d } = deps();
    await expect(
      runRelease({ version: '0.12.0', zipPath: '/z.zip', env: readStoreEnv(ENV), deps: d }),
    ).rejects.toThrow(/0\.12\.0 is already uploaded/);
    expect(calls).toEqual(['token', 'getItem']);
  });

  it('uploads then publishes for a new version', async () => {
    const { calls, deps: d } = deps();
    const out = await runRelease({
      version: '0.13.0',
      zipPath: '/z.zip',
      env: readStoreEnv(ENV),
      deps: d,
    });
    expect(out).toBe('published');
    expect(calls).toEqual(['token', 'getItem', 'readZip', 'upload', 'publish']);
  });

  it('never publishes when the upload fails', async () => {
    const { calls, deps: d } = deps({
      uploadPackage: async () => {
        throw new Error('CWS upload failed (uploadState=FAILURE)');
      },
    });
    await expect(
      runRelease({ version: '0.13.0', zipPath: '/z.zip', env: readStoreEnv(ENV), deps: d }),
    ).rejects.toThrow(/upload failed/);
    expect(calls).not.toContain('publish');
  });

  it('explains a missing store package instead of leaking ENOENT', async () => {
    const { deps: d } = deps({
      readZip: () => {
        throw new Error("ENOENT: no such file or directory, open '/z.zip'");
      },
    });
    await expect(
      runRelease({ version: '0.13.0', zipPath: '/z.zip', env: readStoreEnv(ENV), deps: d }),
    ).rejects.toThrow(/Store package not found at \/z\.zip/);
  });

  it('dry-run stops after the preflight', async () => {
    const { calls, deps: d } = deps();
    const out = await runRelease({
      version: '0.13.0',
      zipPath: '/z.zip',
      env: readStoreEnv(ENV),
      dryRun: true,
      deps: d,
    });
    expect(out).toBe('dry-run');
    expect(calls).toEqual(['token', 'getItem']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/publish-store-release.test.ts`
Expected: FAIL — cannot resolve `./publish-store-release`.

- [ ] **Step 3: Write the implementation**

Create `scripts/publish-store-release.ts`:

```ts
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getAccessToken,
  getItem,
  publishItem,
  uploadPackage,
  type CwsCreds,
  type CwsItem,
} from './cws-client';

// Uploads the store build to the Chrome Web Store and submits it for review (#266).
// Run via `npm run release:store` from the repo root, which builds the store package
// first. Modelled on publish-extension-release.ts (the off-store bot channel), which
// stays a separate command.

export const DEFAULT_ITEM_ID = 'fdelmnhijeiojadcaihfdpecfcldbndg';

export interface StoreEnv extends CwsCreds {
  itemId: string;
}

export function readStoreEnv(env: Record<string, string | undefined>): StoreEnv {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set — see docs/extension-release.md (#266 setup)`);
    return v;
  };
  return {
    clientId: need('CWS_CLIENT_ID'),
    clientSecret: need('CWS_CLIENT_SECRET'),
    refreshToken: need('CWS_REFRESH_TOKEN'),
    itemId: env.CWS_ITEM_ID || DEFAULT_ITEM_ID,
  };
}

export function storeZipPath(extDir: string, version: string): string {
  return join(extDir, `warsaw-beer-overlay-${version}-store.zip`);
}

export interface ReleaseDeps {
  getAccessToken: (creds: CwsCreds) => Promise<string>;
  getItem: (itemId: string, token: string) => Promise<CwsItem>;
  uploadPackage: (itemId: string, zip: Buffer, token: string) => Promise<void>;
  publishItem: (itemId: string, token: string) => Promise<string[]>;
  readZip: (path: string) => Buffer;
}

export const defaultDeps: ReleaseDeps = {
  getAccessToken: (creds) => getAccessToken(creds),
  getItem: (itemId, token) => getItem(itemId, token),
  uploadPackage: (itemId, zip, token) => uploadPackage(itemId, zip, token),
  publishItem: (itemId, token) => publishItem(itemId, token),
  readZip: (path) => readFileSync(path),
};

export async function runRelease(opts: {
  version: string;
  zipPath: string;
  env: StoreEnv;
  dryRun?: boolean;
  deps?: ReleaseDeps;
}): Promise<'published' | 'dry-run'> {
  const deps = opts.deps ?? defaultDeps;
  const token = await deps.getAccessToken(opts.env);

  // Preflight: read the draft first. It turns the most common mistake (forgetting the
  // version bump) into a clear message BEFORE a minute-long upload, and it fails fast on
  // credential/access problems.
  const item = await deps.getItem(opts.env.itemId, token);
  if (item.crxVersion === opts.version) {
    throw new Error(
      `Version ${opts.version} is already uploaded to item ${item.id} — bump ` +
        '`extension/package.json` (and add a matching CHANGELOG section) first.',
    );
  }
  console.log(
    `item ${item.id}: draft ${item.crxVersion ?? '(none)'} → uploading ${opts.version}`,
  );
  if (opts.dryRun) return 'dry-run';

  let zip: Buffer;
  try {
    zip = deps.readZip(opts.zipPath);
  } catch {
    throw new Error(
      `Store package not found at ${opts.zipPath} — build it with ` +
        '`npm --prefix extension run package:store` (or just use `npm run release:store`).',
    );
  }
  await deps.uploadPackage(opts.env.itemId, zip, token);
  console.log(`uploaded ${opts.zipPath} (${zip.length} bytes)`);

  const status = await deps.publishItem(opts.env.itemId, token);
  console.log(`submitted for review: ${status.join(', ')}`);
  return 'published';
}

async function main(): Promise<void> {
  const root = resolve(__dirname, '..');
  const extDir = resolve(root, 'extension');
  const version = (
    JSON.parse(readFileSync(resolve(extDir, 'package.json'), 'utf8')) as { version: string }
  ).version;

  await runRelease({
    version,
    zipPath: storeZipPath(extDir, version),
    env: readStoreEnv(process.env),
    dryRun: process.argv.includes('--dry-run'),
  });
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/publish-store-release.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/publish-store-release.ts scripts/publish-store-release.test.ts
git commit -m "feat(#266): store release orchestrator with version preflight and dry-run"
```

---

### Task 9: Wire up `npm run release:store`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the script**

In the root `package.json`, inside `"scripts"`, next to `"cws:auth"`:

```json
"release:store": "npm --prefix extension run package:store && tsx scripts/publish-store-release.ts",
```

`package:store` already sets `CWS_BUILD=1`, which (after Task 7) makes `zip-dist.py`
write `extension/warsaw-beer-overlay-<version>-store.zip` — exactly the path
`storeZipPath()` resolves.

- [ ] **Step 2: Verify the whole suite and types**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 3: Verify the wiring without mutating the store**

Run: `npx tsx scripts/publish-store-release.ts --dry-run`
Expected: `item fdelmnhijeiojadcaihfdpecfcldbndg: draft 0.12.0 → uploading 0.13.0`
(exact versions may differ). If the local version equals the draft version, the expected
output is instead the "already uploaded" error — that is also a pass for this step.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat(#266): npm run release:store — build, upload, submit for review"
```

---

### Task 10: Documentation

**Files:**
- Modify: `spec.md` §5.6 (secrets) and §6.4 (CWS distribution)
- Modify: `docs/cws-listing.md` (operational checklist)
- Modify: `docs/extension-release.md` (runbook)

- [ ] **Step 1: `spec.md` §6.4**

Replace the bullet that currently reads:

> - **Реліз під час переходу — обидва канали.** Нова версія = `npm run package:store` → **ручний** аплоад у CWS dashboard (автоматизація відкладена, #266) **та** `npm run release` (off-store dev zip + bot-broadcast, §6.1) для тестерів, що ще на unpacked. Після cutover лишається лише перший.

with:

> - **Реліз під час переходу — обидва канали.** Нова версія = `npm run release:store` (#266: `package:store` → upload у CWS → submit for review, локально, креденшели з `.env`) **та** `npm run release` (off-store dev zip + bot-broadcast, §6.1) для тестерів, що ще на unpacked. Після cutover лишається лише перший. Store-збірка пишеться в окремий файл `warsaw-beer-overlay-<version>-store.zip`, щоб не затирати dev-zip, чий sha256 уже в `extension_releases` (§3.12). Ручний аплоад через dashboard лишається як фолбек.

Also update the stale status line in the same section — `item подано на рев'ю
2026-07-10; версія 0.11.0` — to reflect that 0.12.0 is live.

- [ ] **Step 2: `spec.md` §5.6 (secrets)**

Add the four variables to the configuration list, in the style of the surrounding
entries:

> - `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` — OAuth-креденшели Chrome Web Store API (#266), тільки для `npm run release:store`; видаються Desktop-клієнтом у Google Cloud, consent screen МУСИТЬ бути **In production** (у *Testing* refresh-токен живе 7 днів). Отримання: `npm run cws:auth`.
> - `CWS_ITEM_ID` — id store-item (за замовчуванням `fdelmnhijeiojadcaihfdpecfcldbndg`).

- [ ] **Step 3: `docs/cws-listing.md`**

Replace the last operational-checklist item:

> - [ ] Upload the store package (`cd extension && npm run package:store`) and submit for
>       review.

with:

> - [ ] Upload + submit: `npm run release:store` from the repo root (builds the store
>       package, uploads it and submits for review; see `docs/extension-release.md` for
>       the one-time OAuth setup). Manual dashboard upload of
>       `extension/warsaw-beer-overlay-<version>-store.zip` remains a fallback.

- [ ] **Step 4: `docs/extension-release.md`**

Append a new section (outer fence is four backticks because the content contains fenced
blocks of its own):

````markdown
## Chrome Web Store channel (#266)

Store releases are a separate command from the off-store bot channel:

```bash
npm run release:store     # package:store → upload → submit for review
npm run release:store -- --dry-run   # credentials + preflight only, no mutation
```

The version must be bumped in `extension/package.json` first; the preflight refuses to
re-upload a version the store draft already carries.

### One-time OAuth setup

1. Google Cloud project → enable **Chrome Web Store API**.
2. OAuth consent screen → **External**, then **publish it** so the status is
   **In production**. In *Testing* mode Google expires refresh tokens after 7 days.
3. Credentials → OAuth client ID → **Desktop app** → copy the client id/secret into
   `.env` as `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET`.
4. `npm run cws:auth` → open the printed URL (also written to `./tmp/cws-auth-url.txt`),
   grant access, then copy the `CWS_REFRESH_TOKEN=…` line from `./tmp/cws-env.txt` into
   `.env`. If the browser cannot reach `http://127.0.0.1:8976`, paste the `code=` value
   from the address bar: `npm run cws:auth -- --code <value>`.
5. `npm run cws:auth -- --verify` must print an `OK — item …` line.

`invalid_grant` later on means the token was revoked or the consent screen slipped back
to *Testing* — redo step 4.
````

Note: the `--dry-run` flag is consumed by `publish-store-release.ts`, so it must be
passed after `--` when invoked through npm.

- [ ] **Step 5: Confirm no extension user-facing doc change is needed**

`docs/extension-install-uk.md` and `docs/extension-install-en.md` are **not** modified:
the CLAUDE.md rule covers user-facing extension changes (new shop, option, popup button,
badge, install flow). This change is a releaser-only tool — no permission, UI or
behaviour change. State this explicitly in the PR description.

- [ ] **Step 6: Commit**

```bash
git add spec.md docs/cws-listing.md docs/extension-release.md
git commit -m "docs(#266): automated CWS upload in spec, listing checklist and runbook"
```

---

### Task 11: Full verification and PR

**Files:** none

- [ ] **Step 1: Run everything**

```bash
npm test && npm run typecheck && npm --prefix extension test && npm --prefix extension run typecheck
```

Expected: all green. Record the actual counts — do not claim success without the output.

- [ ] **Step 2: Confirm no secret leaked into the diff**

Run: `git diff origin/main... | grep -iE "CWS_(CLIENT_SECRET|REFRESH_TOKEN)=" | grep -v "is not set"`
Expected: no output (the only occurrences are variable names in docs/code, never values).

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/266-cws-store-upload
gh pr create --title "feat(#266): automate Chrome Web Store uploads" --body "<summary; Closes #266; note that install docs are intentionally untouched (releaser-only tool); note the store/dev zip filename split>"
```

- [ ] **Step 4: AI review loop**

Wait for the AI reviewer, read every comment, verify each claim against the live code
path, push back on wrong ones and fix the valid ones. The task is not done at green
tests (project policy `feedback_pr_review_loop`).

- [ ] **Step 5: Report ready to merge**

Do **not** run `gh pr merge` — the maintainer merges (project policy
`feedback_user_merges_prs`).

---

### Task 12 (after merge, requires explicit maintainer go-ahead): first automated store release

**Files:** none

This performs a real, outward-facing action: it submits a version to Google's review
queue. Ask before running it.

- [ ] **Step 1: Confirm the version and changelog**

`extension/package.json` is at 0.13.0 and `extension/CHANGELOG.md` has a matching
`## [0.13.0]` section.

- [ ] **Step 2: Dry run**

Run: `npm run release:store -- --dry-run`
Expected: `item fdelmnhijeiojadcaihfdpecfcldbndg: draft 0.12.0 → uploading 0.13.0`.

- [ ] **Step 3: Release**

Run: `npm run release:store`
Expected: `uploaded …-store.zip (N bytes)` then `submitted for review: OK`.

- [ ] **Step 4: Confirm in the dashboard**

The item shows 0.13.0 as "Pending review".

- [ ] **Step 5: Clean up the scratch folder**

Run: `rm -rf ./tmp/*` — `./tmp/cws-env.txt` holds a live refresh token and the CLAUDE.md
policy is to wipe the folder when the task ends.
