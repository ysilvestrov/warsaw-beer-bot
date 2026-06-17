import { describe, it, expect, vi, afterEach } from 'vitest';
import { postMatch, getHealth, ApiError } from './client';
import type { MatchResult } from './types';

const result: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: null,
  is_drunk: false,
  drunk_uncertain: false,
  user_rating: null,
};

afterEach(() => vi.restoreAllMocks());

describe('api/client', () => {
  it('postMatch posts beers with bearer auth and returns results', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ results: [result] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await postMatch('https://api.test', 'tok', [{ brewery: 'PINTA', name: 'Hazy Morning' }]);

    expect(out).toEqual([result]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/match');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
  });

  it('postMatch throws ApiError code "unauthorized" on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(postMatch('https://api.test', 'bad', [{ brewery: 'X', name: 'Y' }]))
      .rejects.toMatchObject({ code: 'unauthorized' } as Partial<ApiError>);
  });

  it('postMatch throws ApiError code "server" on 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await expect(postMatch('https://api.test', 'tok', [{ brewery: 'X', name: 'Y' }]))
      .rejects.toMatchObject({ code: 'server' });
  });

  it('postMatch throws ApiError code "network" when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    await expect(postMatch('https://api.test', 'tok', [{ brewery: 'X', name: 'Y' }]))
      .rejects.toMatchObject({ code: 'network' });
  });

  it('getHealth returns true on { ok: true }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    expect(await getHealth('https://api.test')).toBe(true);
  });

  it('getHealth returns false when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    expect(await getHealth('https://api.test')).toBe(false);
  });

  it('postMatch throws ApiError "network" when the request times out', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
    ));
    await expect(postMatch('https://api.test', 'tok', [{ brewery: 'X', name: 'Y' }], 20))
      .rejects.toMatchObject({ code: 'network' });
  });

  it('getHealth returns false when the request times out', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
    ));
    expect(await getHealth('https://api.test', 20)).toBe(false);
  });
});

import { postEnrichCandidates, postEnrichResult } from './client';

describe('postEnrichCandidates', () => {
  it('posts beers and returns candidates', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ candidates: [{ brewery: 'B', name: 'N', eligible: true, searchUrl: 'u' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await postEnrichCandidates('https://api', 'tok', [{ brewery: 'B', name: 'N' }]);
    expect(out[0]).toEqual({ brewery: 'B', name: 'N', eligible: true, searchUrl: 'u' });
    expect(calls[0].url).toBe('https://api/enrich/candidates');
    vi.unstubAllGlobals();
  });
});

describe('postEnrichResult', () => {
  it('posts html and returns the status payload', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'matched', untappd_id: 5001, rating_global: 3.9 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await postEnrichResult('https://api', 'tok', { brewery: 'B', name: 'N', html: '<x>' });
    expect(out).toEqual({ status: 'matched', untappd_id: 5001, rating_global: 3.9 });
    vi.unstubAllGlobals();
  });
});

import { getCheckinSyncState, postCheckinSyncPage } from './client';

describe('getCheckinSyncState', () => {
  it('GETs state and returns the parsed body', async () => {
    const body = { username: 'bob', deepest_max_id: null, complete: false, serverCount: 0, profileTotal: null };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await getCheckinSyncState('http://x', 'tok');
    expect(out).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://x/checkins/sync/state');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
    vi.unstubAllGlobals();
  });

  it('throws not_linked-coded error on 409', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not_linked' }), { status: 409 })));
    await expect(getCheckinSyncState('http://x', 'tok')).rejects.toMatchObject({ code: 'not_linked' });
    vi.unstubAllGlobals();
  });
});

describe('postCheckinSyncPage', () => {
  it('POSTs html+maxId and returns the page result', async () => {
    const body = { merged: 1, alreadyKnown: 0, pageSize: 1, nextMaxId: '200', profileTotal: 3, serverCount: 1, complete: false };
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const out = await postCheckinSyncPage('http://x', 'tok', '<html>', null);
    expect(out).toEqual(body);
    expect(spy).toHaveBeenCalledWith('http://x/checkins/sync', expect.objectContaining({ method: 'POST' }));
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ html: '<html>', maxId: null });
    vi.unstubAllGlobals();
  });

  it('maps 502 to blocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'blocked' }), { status: 502 })));
    await expect(postCheckinSyncPage('http://x', 'tok', '<html>', null)).rejects.toMatchObject({ code: 'blocked' });
    vi.unstubAllGlobals();
  });
});
