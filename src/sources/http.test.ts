import { createHttp, CookieExpiredError } from './http';

test('createHttp serialises requests through the queue (concurrency 1)', async () => {
  let active = 0;
  let maxActive = 0;
  const fakeFetch: typeof fetch = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return new Response('ok', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 10, fetchImpl: fakeFetch });
  await Promise.all([http.get('a'), http.get('b'), http.get('c')]);
  expect(maxActive).toBe(1);
});

test('sends Cookie header with untappd_user_v3_e when cookie option is set', async () => {
  const calls: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (_, init) => {
    calls.push(init ?? {});
    return new Response('ok', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, cookie: 'abc123' });
  await http.get('https://untappd.com/user/foo/beers');
  expect((calls[0].headers as Record<string, string>)['Cookie']).toBe('untappd_user_v3_e=abc123');
});

test('throws CookieExpiredError on any 3xx when redirect is manual', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 307 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  await expect(http.get('https://untappd.com/user/foo/beers')).rejects.toBeInstanceOf(CookieExpiredError);
});

test('throws generic Error (not CookieExpiredError) on 4xx', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 403 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl });
  const err = await http.get('https://example.com/').catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(CookieExpiredError);
  expect(err.message).toContain('HTTP 403');
});

test('throws HttpError carrying the status on a non-ok response', async () => {
  const { HttpError } = await import('./http');
  const fetchImpl: typeof fetch = async () => new Response('', { status: 403 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl });
  await expect(http.get('https://untappd.com/search?q=x')).rejects.toMatchObject({
    name: 'HttpError', status: 403,
  });
});

test('passes redirect option to fetch when set', async () => {
  const calls: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (_, init) => {
    calls.push(init ?? {});
    return new Response('ok', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  await http.get('https://example.com/ok');
  expect(calls[0].redirect).toBe('manual');
});

import { ProxyAgent } from 'undici';
import { normalizeProxyUrl } from './http';

describe('normalizeProxyUrl', () => {
  test('prepends http:// when no scheme', () => {
    expect(normalizeProxyUrl('u:p@p.webshare.io:80')).toBe('http://u:p@p.webshare.io:80');
  });
  test('leaves an explicit scheme untouched', () => {
    expect(normalizeProxyUrl('http://u:p@host:80')).toBe('http://u:p@host:80');
  });
});

describe('createHttp proxy wiring', () => {
  function capturingFetch() {
    const calls: { url: string; init: RequestInit & { dispatcher?: unknown } }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '<html>ok</html>' } as Response;
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  test('passes a ProxyAgent dispatcher when proxyUrl is set', async () => {
    const { f, calls } = capturingFetch();
    const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl: f, proxyUrl: 'u:p@p.webshare.io:80' });
    await http.get('https://untappd.com/search?q=x');
    expect(calls[0].init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  test('no dispatcher when proxyUrl is unset', async () => {
    const { f, calls } = capturingFetch();
    const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl: f });
    await http.get('https://untappd.com/search?q=x');
    expect(calls[0].init.dispatcher).toBeUndefined();
  });
});
