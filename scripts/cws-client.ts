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
        'npm run cws:auth (scripts/cws-auth-bootstrap.ts).',
    );
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    const detail = [body.error, body.error_description].filter(Boolean).join(': ');
    throw new Error(`CWS auth failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return body.access_token;
}

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
    // `Buffer` really does satisfy the runtime BodyInit contract (Node's global fetch is
    // undici, which accepts a Buffer body directly) — this cast only works around a type
    // mismatch where `vitest/globals` pulls in lib.dom's `BodyInit`, whose ArrayBufferView
    // arm is pinned to `Uint8Array<ArrayBuffer>` and rejects Node's `Buffer<ArrayBufferLike>`.
    body: zip as unknown as BodyInit,
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
