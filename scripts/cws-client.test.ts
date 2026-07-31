import { getAccessToken, getItem } from './cws-client';

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
