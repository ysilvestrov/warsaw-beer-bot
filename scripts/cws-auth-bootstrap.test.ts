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
