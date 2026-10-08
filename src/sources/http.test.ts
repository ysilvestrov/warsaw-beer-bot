import { createHttp, CookieExpiredError, HttpError } from './http';
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

test('throws CookieExpiredError on 3xx redirecting to /login when redirect is manual', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('', { status: 307, headers: { Location: 'https://untappd.com/login?go_to=https%3A%2F%2Funtappd.com%2Fuser%2Ffoo%2Fbeers' } });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  await expect(http.get('https://untappd.com/user/foo/beers')).rejects.toBeInstanceOf(CookieExpiredError);
});

test('throws CookieExpiredError on 3xx with relative /login Location when redirect is manual', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('', { status: 307, headers: { Location: '/login?go_to=%2Fuser%2Ffoo%2Fbeers' } });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  await expect(http.get('https://untappd.com/user/foo/beers')).rejects.toBeInstanceOf(CookieExpiredError);
});

test('follows safe 3xx redirect when redirect is manual and returns body', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    calls.push(String(url));
    if (url === 'https://untappd.com/v/old-slug/11142155/activity') {
      return new Response('', {
        status: 307,
        headers: { Location: 'https://untappd.com/v/new-slug/11142155/activity' },
      });
    }
    return new Response('canonical-body', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  const body = await http.get('https://untappd.com/v/old-slug/11142155/activity');
  expect(body).toBe('canonical-body');
  expect(calls).toEqual([
    'https://untappd.com/v/old-slug/11142155/activity',
    'https://untappd.com/v/new-slug/11142155/activity',
  ]);
});

test('invokes onRedirect callback when safe redirect is followed', async () => {
  const redirected: { from: string; to: string }[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    if (url === 'https://untappd.com/v/old/1') {
      return new Response('', { status: 307, headers: { Location: '/v/new/1' } });
    }
    return new Response('done', { status: 200 });
  };
  const http = createHttp({
    userAgent: 'ua',
    minGapMs: 0,
    fetchImpl,
    redirect: 'manual',
    onRedirect: (from, to) => redirected.push({ from, to }),
  });
  const reqRedirected: { from: string; to: string }[] = [];
  const body = await http.get('https://untappd.com/v/old/1', {
    onRedirect: (from, to) => reqRedirected.push({ from, to }),
  });
  expect(body).toBe('done');
  expect(redirected).toEqual([{ from: 'https://untappd.com/v/old/1', to: 'https://untappd.com/v/new/1' }]);
  expect(reqRedirected).toEqual([{ from: 'https://untappd.com/v/old/1', to: 'https://untappd.com/v/new/1' }]);
});

test('throws HttpError and does not leak cookies on cross-origin redirect', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('', { status: 307, headers: { Location: 'https://evil.example/login' } });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual', cookie: 'secret123' });
  const err = await http.get('https://untappd.com/user/foo/beers').catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).not.toBeInstanceOf(CookieExpiredError);
  expect(err.status).toBe(307);
  expect(err.url).toBe('https://untappd.com/user/foo/beers');
});

test('throws HttpError on insecure plain HTTP redirect', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('', { status: 307, headers: { Location: 'http://untappd.com/v/new/1' } });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual', cookie: 'secret123' });
  const err = await http.get('https://untappd.com/v/old/1').catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err.status).toBe(307);
});

test('succeeds when redirect chain has exactly 3 hops followed by 200', async () => {
  let count = 0;
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    count++;
    urls.push(String(url));
    if (count <= 3) {
      return new Response('', { status: 307, headers: { Location: `https://untappd.com/hop/${count}` } });
    }
    return new Response('hop-3-success', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  const body = await http.get('https://untappd.com/hop/0');
  expect(body).toBe('hop-3-success');
  expect(count).toBe(4);
  expect(urls).toEqual([
    'https://untappd.com/hop/0',
    'https://untappd.com/hop/1',
    'https://untappd.com/hop/2',
    'https://untappd.com/hop/3',
  ]);
});

test('throws HttpError when redirect chain exceeds 3 hops (at 4th redirect)', async () => {
  let count = 0;
  const fetchImpl: typeof fetch = async () => {
    count++;
    return new Response('', { status: 307, headers: { Location: `https://untappd.com/hop/${count}` } });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  const err = await http.get('https://untappd.com/hop/0').catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(err.status).toBe(307);
  expect(err.url).toBe('https://untappd.com/hop/3');
  expect(count).toBe(4);
});

test('throws HttpError on 3xx without Location header when redirect is manual', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 307 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  await expect(http.get('https://untappd.com/v/old/1')).rejects.toMatchObject({
    name: 'HttpError',
    status: 307,
  });
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
  const { HttpError } = await import('./http.js');
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

test('a persistent 200 block page throws a block-status HttpError (so the breaker sees it)', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('<html>Just a moment...</html>', { status: 200 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  const err = await http.get('https://untappd.com/beer/1').catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect(isBlockStatus((err as HttpError).status)).toBe(true);
  expect(rotator.rotations()).toBe(1);
});

test('a persistent 429 retains 429 status', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 429 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock });
  await expect(http.get('https://untappd.com/beer/1')).rejects.toMatchObject({ name: 'HttpError', status: 429 });
});

test('does not rotate on a 3xx under redirect:manual (cookie expiry, not an IP block)', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () =>
    new Response('', { status: 307, headers: { Location: 'https://untappd.com/login?go_to=x' } });
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

test('retries up to maxBlockRetries and returns the body on a later success', async () => {
  const rotator = fakeRotator();
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call++;
    return call <= 3
      ? new Response('', { status: 403 })
      : new Response('ok-body', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock, maxBlockRetries: 6 });
  expect(await http.get('https://untappd.com/beer/1')).toBe('ok-body');
  expect(rotator.rotations()).toBe(3);
  expect(call).toBe(4);
});

test('exhausts maxBlockRetries then throws a block HttpError (rotates exactly budget times)', async () => {
  const rotator = fakeRotator();
  const fetchImpl: typeof fetch = async () => new Response('', { status: 403 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, rotator, isBlock: untappdBlock, maxBlockRetries: 3 });
  await expect(http.get('https://untappd.com/beer/1')).rejects.toMatchObject({ name: 'HttpError', status: 403 });
  expect(rotator.rotations()).toBe(3);
});

test('preserves headers and proxy dispatcher across followed safe redirect hops', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeDispatcher = {} as unknown as import('undici').Dispatcher;
  const rotator = {
    rotations: () => 0,
    current: () => fakeDispatcher,
    rotate: () => {},
    close: () => {},
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (url === 'https://untappd.com/v/old/1') {
      return new Response('', { status: 307, headers: { Location: 'https://untappd.com/v/new/1' } });
    }
    return new Response('ok', { status: 200 });
  };
  const http = createHttp({
    userAgent: 'test-ua',
    cookie: 'session123',
    minGapMs: 0,
    fetchImpl,
    redirect: 'manual',
    rotator,
  });
  const body = await http.get('https://untappd.com/v/old/1');
  expect(body).toBe('ok');
  expect(calls).toHaveLength(2);
  expect((calls[0].init?.headers as Record<string, string>)['User-Agent']).toBe('test-ua');
  expect((calls[0].init?.headers as Record<string, string>)['Cookie']).toBe('untappd_user_v3_e=session123');
  expect((calls[0].init as Record<string, unknown>)['dispatcher']).toBe(fakeDispatcher);
  expect((calls[1].init?.headers as Record<string, string>)['User-Agent']).toBe('test-ua');
  expect((calls[1].init?.headers as Record<string, string>)['Cookie']).toBe('untappd_user_v3_e=session123');
  expect((calls[1].init as Record<string, unknown>)['dispatcher']).toBe(fakeDispatcher);
});

test('rotates and retries when a followed redirect hop encounters a block', async () => {
  const rotator = fakeRotator();
  let hop2Calls = 0;
  const fetchImpl: typeof fetch = async (url) => {
    if (url === 'https://untappd.com/v/old/1') {
      return new Response('', { status: 307, headers: { Location: 'https://untappd.com/v/new/1' } });
    }
    if (url === 'https://untappd.com/v/new/1') {
      hop2Calls++;
      return hop2Calls === 1
        ? new Response('', { status: 403 })
        : new Response('redirected-body', { status: 200 });
    }
    throw new Error(`Unexpected url ${url}`);
  };
  const http = createHttp({
    userAgent: 'ua',
    minGapMs: 0,
    fetchImpl,
    redirect: 'manual',
    rotator,
    isBlock: untappdBlock,
  });
  const body = await http.get('https://untappd.com/v/old/1');
  expect(body).toBe('redirected-body');
  expect(rotator.rotations()).toBe(1);
  expect(hop2Calls).toBe(2);
});
