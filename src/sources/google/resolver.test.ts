// src/sources/google/resolver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { parseCseResponse, createGoogleResolver } from './resolver';

const MARYENSZTADT_CSE = {
  items: [
    {
      title:
        'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon - Maryensztadt - Untappd',
      link:
        'https://untappd.com/b/maryensztadt-barrel-aged-project-ice-imperial-brett-baltic-porter-double-barrel-aged-dry-plum-and-cinnamon/5158585',
      pagemap: { metatags: [{ 'twitter:data1': '11.5% ABV' }] },
    },
    {
      title: 'Maryensztadt - Zwoleń - Untappd', // brewery page, not /b/ — dropped
      link: 'https://untappd.com/Maryensztadt',
    },
  ],
};

describe('parseCseResponse', () => {
  it('extracts bid/name/brewery from /b/ items and skips non-beer links', () => {
    const out = parseCseResponse(MARYENSZTADT_CSE);
    expect(out).toHaveLength(1);
    expect(out[0].bid).toBe(5158585);
    expect(out[0].beer_name).toBe(
      'Barrel Aged Project: Ice Imperial Brett Baltic Porter Double Barrel Aged Dry Plum & Cinnamon',
    );
    expect(out[0].brewery_name).toBe('Maryensztadt');
    expect(out[0].abv).toBeCloseTo(11.5);
  });

  it('returns [] for empty / missing items', () => {
    expect(parseCseResponse({})).toEqual([]);
    expect(parseCseResponse({ items: [] })).toEqual([]);
  });

  it('yields null abv when pagemap has no ABV', () => {
    const out = parseCseResponse({
      items: [{ title: 'Pan IPAni - Trzech Kumpli - Untappd', link: 'https://untappd.com/b/trzech-kumpli-pan-ipani/1000186' }],
    });
    expect(out[0].abv).toBeNull();
  });
});

describe('createGoogleResolver', () => {
  it('calls the CSE endpoint with key/cx/q and parses the result', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(MARYENSZTADT_CSE), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = createGoogleResolver({ key: 'K', cx: 'C', fetchImpl });
    const out = await r.resolve('Maryensztadt', 'BA Suszona Śliwka');
    expect(out[0].bid).toBe(5158585);
    const calledUrl = (fetchImpl as unknown as vi.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('key=K');
    expect(calledUrl).toContain('cx=C');
    expect(calledUrl).toContain('q=Maryensztadt');
  });

  it('resolves [] on a non-200 (e.g. 429 quota) instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('quota', { status: 429 })) as unknown as typeof fetch;
    const r = createGoogleResolver({ key: 'K', cx: 'C', fetchImpl });
    await expect(r.resolve('a', 'b')).resolves.toEqual([]);
  });
});
