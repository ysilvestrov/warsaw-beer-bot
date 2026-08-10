import { describe, it, expect, vi } from 'vitest';
import { runEnrichment, MAX_SEARCHES_PER_PAGE, type EnrichDeps } from './enrich';
import type { EnrichResult } from '../api/types';

function deps(over: Partial<EnrichDeps> = {}): EnrichDeps {
  return {
    getCandidates: vi.fn(async (beers: { brewery: string; name: string }[]) =>
      beers.map((b) => ({
        brewery: b.brewery,
        name: b.name,
        eligible: true,
        algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer' as const, query: `q:${b.name}`, hitsPerPage: 5 },
      })),
    ),
    fetchSearch: vi.fn(async () => ({ hits: [{ bid: 7 }] })),
    submitResult: vi.fn(async (): Promise<EnrichResult> => ({ status: 'matched', untappd_id: 7, rating_global: 4.0 })),
    setSearching: vi.fn(),
    setEnriched: vi.fn(),
    setOrphan: vi.fn(),
    sleep: vi.fn(async () => {}),
    delayMs: 4000,
    ...over,
  };
}

const beers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `k${i}`, brewery: 'B', name: `N${i}` }));

describe('runEnrichment', () => {
  it('registers all orphans but searches at most MAX_SEARCHES_PER_PAGE (no abstain on big pages)', async () => {
    const d = deps();
    await runEnrichment(beers(MAX_SEARCHES_PER_PAGE + 5), d); // 25 orphans, all eligible
    expect(d.getCandidates).toHaveBeenCalledTimes(1); // all registered, not abstained
    expect(d.fetchSearch).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE); // search capped at 20
  });

  it('searches eligible beers, throttling between them, and resolves matched → setEnriched', async () => {
    const d = deps();
    await runEnrichment(beers(2), d);
    expect(d.getCandidates).toHaveBeenCalledTimes(1);
    expect(d.fetchSearch).toHaveBeenCalledTimes(2);
    // #369: submitResult now takes a 4th `facts` argument; these beers publish none.
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {});
    expect(d.setSearching).toHaveBeenCalledTimes(2);
    expect(d.setEnriched).toHaveBeenCalledWith('k0', 7, 4.0);
    expect(d.sleep).toHaveBeenCalledTimes(1); // between the two
  });

  it('skips ineligible beers', async () => {
    const d = deps({
      getCandidates: vi.fn(async (bs: { brewery: string; name: string }[]) =>
        bs.map((b) => ({
          brewery: b.brewery,
          name: b.name,
          eligible: false,
          algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer' as const, query: 'u', hitsPerPage: 5 },
        })),
      ),
    });
    await runEnrichment(beers(2), d);
    expect(d.fetchSearch).not.toHaveBeenCalled();
  });

  it('on not_found, clears the loader back to ⚪ and does not enrich', async () => {
    const d = deps({ submitResult: vi.fn(async (): Promise<EnrichResult> => ({ status: 'not_found' })) });
    await runEnrichment(beers(1), d);
    expect(d.setEnriched).not.toHaveBeenCalled();
    expect(d.setOrphan).toHaveBeenCalledWith('k0', 'B', 'N0');
  });
});

// #369: shop-published facts must reach BOTH endpoints — /enrich/candidates persists
// them for every registered card, /enrich/result keeps the endpoint correct on its own.
describe('runEnrichment relays orphan facts (#369)', () => {
  it('forwards abv and style to getCandidates and submitResult, keeping 0', async () => {
    const d = deps();
    await runEnrichment(
      [{ key: 'k0', brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny', abv: 0, style: 'Kwas Chlebowy' }],
      d,
    );
    expect(d.getCandidates).toHaveBeenCalledWith([
      { brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny', abv: 0, style: 'Kwas Chlebowy' },
    ]);
    expect(d.submitResult).toHaveBeenCalledWith(
      'AleBrowar', 'Kwas Chlebowy Jasny', { hits: [{ bid: 7 }] },
      { abv: 0, style: 'Kwas Chlebowy' },
    );
  });

  it('omits absent facts rather than sending undefined keys', async () => {
    const d = deps();
    await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0' }], d);
    expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0' }]);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {});
  });
});

// #384: the shop-published bid must reach both endpoints — /enrich/candidates needs it to
// see that a stored link is contradicted, /enrich/result to repair it.
describe('runEnrichment relays the published bid (#384)', () => {
  const orphan = {
    key: 'k0', brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
    bid: 6648348, bidSlug: 'mad-brew-tomatol-bulgogi',
  };

  it('sends the bid to getCandidates, but not the slug/brand it has no use for', async () => {
    const d = deps();
    await runEnrichment([orphan], d);
    expect(d.getCandidates).toHaveBeenCalledWith([
      { brewery: 'Mad Brew', name: 'Tomatol Bulgogi', bid: 6648348 },
    ]);
  });

  it('sends bid, slug and the card brand as brand to submitResult', async () => {
    const d = deps();
    await runEnrichment([orphan], d);
    expect(d.submitResult).toHaveBeenCalledWith(
      'Mad Brew', 'Tomatol Bulgogi', { hits: [{ bid: 7 }] },
      { bid: 6648348, bidSlug: 'mad-brew-tomatol-bulgogi', brand: 'Mad Brew' },
    );
  });

  it('sends no slug or brand when the shop published no bid', async () => {
    const d = deps();
    await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0', bidSlug: 'stray' }], d);
    expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0' }]);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {});
  });

  // runEnrichment is exported: a bid the server's schema would reject (non-positive,
  // fractional, NaN) must be dropped here rather than 400 the whole relay.
  it.each([['zero', 0], ['negative', -5], ['fractional', 1.5], ['NaN', NaN], ['Infinity', Infinity]])(
    'drops a %s bid from both endpoints',
    async (_label, bad) => {
      const d = deps();
      await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0', bid: bad, bidSlug: 's' }], d);
      expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0' }]);
      expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {});
    },
  );
});

// #369 review follow-up: runEnrichment is exported, so it sanitizes rather than
// trusting its caller — a stray NaN would serialize as null and be unmappable.
describe('runEnrichment sanitizes orphan abv (#369)', () => {
  it.each([['NaN', NaN], ['out of range', 9999], ['negative', -1]])(
    'drops an %s abv from both endpoints',
    async (_label, bad) => {
      const d = deps();
      await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0', abv: bad }], d);
      expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0' }]);
      expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {});
    },
  );

  it('keeps a legitimate 0', async () => {
    const d = deps();
    await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0', abv: 0 }], d);
    expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0', abv: 0 }]);
  });
});
