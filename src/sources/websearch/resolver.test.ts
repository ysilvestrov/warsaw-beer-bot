import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBraveResponse, createBraveResolver } from './resolver';

// Real Brave output captured during the 2026-07-26 provider probe. Loaded with
// readFileSync (not a JSON import) to match the fixture convention in
// src/sources/untappd/checkin-feed.test.ts.
const brave = JSON.parse(readFileSync(join(__dirname, '__fixtures__/brave-maryensztadt.json'), 'utf8'));

describe('parseBraveResponse', () => {
  it('extracts bid/name/brewery from /b/ results and skips venue + brewery pages', () => {
    const out = parseBraveResponse(brave);
    expect(out.map((r) => r.bid)).toEqual([5549664, 5158585, 3809861]);
    expect(out[1].beer_name).toBe(
      'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
    );
    expect(out[1].brewery_name).toBe('Maryensztadt');
  });

  it('never reports an abv — Brave carries none', () => {
    expect(parseBraveResponse(brave).every((r) => r.abv === null)).toBe(true);
  });

  it('drops Untappd sub-pages rather than depending on them ranking below the canonical page', () => {
    const out = parseBraveResponse(brave);
    const gose = out.filter((r) => r.bid === 3809861);
    expect(gose).toHaveLength(1);
    // The /photos twin is excluded by URL shape (bidFromLink only matches the
    // canonical `/b/<slug>/<digits>` path), not because it happens to rank
    // below the canonical page — so its "Trzech Kumpli | Photos" garble never
    // has a chance to be picked up in the first place.
    expect(gose[0].brewery_name).toBe('Trzech Kumpli');
  });

  it('drops the canonical result and its /photos twin the same way regardless of which ranks first', () => {
    const out = parseBraveResponse({
      web: {
        results: [
          {
            title: 'Gose | Mango i Marakuja - Trzech Kumpli | Photos - Untappd',
            url: 'https://untappd.com/b/trzech-kumpli-gose-mango-i-marakuja/3809861/photos',
          },
          {
            title: 'Gose z mango i marakują - Trzech Kumpli - Untappd',
            url: 'https://untappd.com/b/trzech-kumpli-gose-z-mango-i-marakuja/3809861',
          },
        ],
      },
    });
    const gose = out.filter((r) => r.bid === 3809861);
    expect(gose).toHaveLength(1);
    expect(gose[0].brewery_name).toBe('Trzech Kumpli');
  });

  it('returns [] for an empty or malformed payload', () => {
    expect(parseBraveResponse({})).toEqual([]);
    expect(parseBraveResponse({ web: {} })).toEqual([]);
    expect(parseBraveResponse({ web: { results: [{ title: 42, url: null }] } } as never)).toEqual([]);
    expect(parseBraveResponse(null as never)).toEqual([]);
  });

  it('drops results whose title is not the "<Beer> - <Brewery> - Untappd" shape', () => {
    const out = parseBraveResponse({
      web: {
        results: [
          { title: 'Some Beer | Untappd', url: 'https://untappd.com/b/x/111' },
          { title: 'Beer - Brewery - Elsewhere', url: 'https://untappd.com/b/x/222' },
        ],
      },
    });
    expect(out).toEqual([]);
  });
});

describe('createBraveResolver', () => {
  function okResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  it('queries Brave with a site-restricted query and the subscription-token header', async () => {
    const fetchImpl = vi.fn(async () => okResponse(brave));
    const resolver = createBraveResolver({ key: 'k-123', fetchImpl: fetchImpl as unknown as typeof fetch });

    const out = await resolver.resolve('Maryensztadt', 'Suszona Śliwka i Cynamon');

    expect(out[1].bid).toBe(5158585);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toContain('https://api.search.brave.com/res/v1/web/search');
    const q = new URL(String(url)).searchParams.get('q');
    expect(q).toBe('Maryensztadt Suszona Śliwka i Cynamon site:untappd.com');
    expect(new URL(String(url)).searchParams.get('count')).toBe('5');
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('k-123');
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json');
  });

  it('returns [] on a non-200 response (429 rate-limit, auth failure, anything)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
    const resolver = createBraveResolver({ key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.resolve('Brewery', 'Beer')).resolves.toEqual([]);
  });

  it('returns [] when the network call throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const resolver = createBraveResolver({ key: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.resolve('Brewery', 'Beer')).resolves.toEqual([]);
  });

  it('logs a failing call so a systematically broken key is visible, not silent', async () => {
    // A dead key looks identical to "nothing matched" from the caller's side —
    // the Google CSE predecessor 403'd for a day before anyone noticed.
    const warn = vi.fn();
    const nonOk = createBraveResolver({
      key: 'k',
      log: { warn },
      fetchImpl: (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch,
    });
    await nonOk.resolve('Brewery', 'Beer');
    expect(warn).toHaveBeenCalledWith({ status: 403 }, expect.stringContaining('non-200'));

    const throws = createBraveResolver({
      key: 'k',
      log: { warn },
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    await throws.resolve('Brewery', 'Beer');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent calls at least minIntervalMs apart', async () => {
    const at: number[] = [];
    const fetchImpl = vi.fn(async () => {
      at.push(Date.now());
      return okResponse({ web: { results: [] } });
    });
    const resolver = createBraveResolver({
      key: 'k',
      minIntervalMs: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([resolver.resolve('A', 'x'), resolver.resolve('B', 'y'), resolver.resolve('C', 'z')]);

    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(55);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(55);
  });

  it('releases the gate for queued callers after a call rejects', async () => {
    const at: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      at.push(Date.now());
      call += 1;
      if (call === 1) throw new Error('ECONNRESET');
      return okResponse(brave);
    });
    const resolver = createBraveResolver({
      key: 'k',
      minIntervalMs: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [first, second, third] = await Promise.all([
      resolver.resolve('A', 'x'),
      resolver.resolve('B', 'y'),
      resolver.resolve('C', 'z'),
    ]);

    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(55);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(55);
    expect(first).toEqual([]);
    expect(second.length).toBeGreaterThan(0);
    expect(third.length).toBeGreaterThan(0);
  });
});
