import { createHttp, CookieExpiredError } from './http';
import { isBlockStatus, isBlockPage } from './untappd/block';

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

import { normalizeProxyUrl } from './http';

describe('normalizeProxyUrl', () => {
  test('prepends http:// when no scheme', () => {
    expect(normalizeProxyUrl('u:p@p.webshare.io:80')).toBe('http://u:p@p.webshare.io:80');
  });
  test('leaves an explicit scheme untouched', () => {
    expect(normalizeProxyUrl('http://u:p@host:80')).toBe('http://u:p@host:80');
  });
});

function fakeRotator(initialRotations = 0) {
  let n = initialRotations;
  return {
    rotations: () => n,
    current: () => ({}) as unknown as import('undici').Dispatcher,
    rotate: () => { n++; },
    close: () => {},
  };
}

const untappdBlock = (status: number, body: string | null) =>
  isBlockStatus(status) || (body !== null && isBlockPage(body));

test('rotates and retries once on a block status, returning the retry body', async () => {
  const rotator = fakeRotator();
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call++;
    return call === 1
      ? new Response('', { status: 403 })
      : new Response('ok-body', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  expect(await http.get('https://untappd.com/beer/1')).toBe('ok-body');
  expect(rotator.rotations()).toBe(1);
  expect(call).toBe(2);
});

test('a 200 Cloudflare block page rotates + retries like a 403', async () => {
  const rotator = fakeRotator();
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call++;
    return call === 1
      ? new Response('<html>Just a moment...</html>', { status: 200 })
      : new Response('real', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  expect(await http.get('https://untappd.com/beer/1')).toBe('real');
  expect(rotator.rotations()).toBe(1);
});

test('throws a block HttpError when the retry also blocks; rotates exactly once', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 403 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  await expect(http.get('https://untappd.com/beer/1')).rejects.toMatchObject({
    name: 'HttpError', status: 403,
  });
  expect(rotator.rotations()).toBe(1);
});

test('does not rotate on a 3xx under redirect:manual (cookie expiry, not an IP block)', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 307 });
  const http = createHttp({
    userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock, redirect: 'manual',
  });
  await expect(http.get('https://untappd.com/user/x/beers')).rejects.toBeInstanceOf(CookieExpiredError);
  expect(rotator.rotations()).toBe(0);
});

test('does not rotate on a non-block non-ok status (e.g. 500)', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 500 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  await expect(http.get('https://untappd.com/beer/1')).rejects.toMatchObject({ name: 'HttpError', status: 500 });
  expect(rotator.rotations()).toBe(0);
});

test('passes rotator.current() as the fetch dispatcher', async () => {
  const marker = { marker: true } as unknown as import('undici').Dispatcher;
  const rotator = { rotations: () => 0, current: () => marker, rotate: () => {}, close: () => {} };
  const calls: (RequestInit & { dispatcher?: unknown })[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator });
  await http.get('https://untappd.com/search?q=x');
  expect(calls[0].dispatcher).toBe(marker);
});

test('no dispatcher and no rotation when rotator is unset', async () => {
  const calls: (RequestInit & { dispatcher?: unknown })[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl });
  await http.get('https://untappd.com/search?q=x');
  expect(calls[0].dispatcher).toBeUndefined();
});

test('rotations() reflects the rotator counter', async () => {
  const rotator = fakeRotator(7);
  const fetchImpl: typeof fetch = async () => new Response('ok', { status: 200 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator });
  await http.get('https://x');
  expect(http.rotations?.()).toBe(7);
});
