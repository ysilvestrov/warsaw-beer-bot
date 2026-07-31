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
