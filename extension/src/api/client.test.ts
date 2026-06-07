import { describe, it, expect, vi, afterEach } from 'vitest';
import { postMatch, getHealth, ApiError } from './client';
import type { MatchResult } from './types';

const result: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: null,
  is_drunk: false,
  user_rating: null,
};

afterEach(() => vi.restoreAllMocks());

describe('api/client', () => {
  it('postMatch posts beers with bearer auth and returns results', async () => {
    const fetchMock = vi.fn(async () =>
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
});
