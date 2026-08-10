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

const rung = (query: string) =>
  ({ appId: 'APP', searchKey: 'KEY', indexName: 'beer' as const, query, hitsPerPage: 5 });

// Every beer carries a two-rung ladder: narrow `n:<name>`, wide `q:<name>`.
const ladderCandidates = () =>
  vi.fn(async (bs: { brewery: string; name: string }[]) =>
    bs.map((b) => ({
      brewery: b.brewery,
      name: b.name,
      eligible: true,
      algolia: rung(`q:${b.name}`),
      algoliaNarrow: rung(`n:${b.name}`),
    })),
  );

// The first beer is single-rung, every later beer two-rung. With an even budget this makes
// the budget run out INSIDE a ladder (1 + 2k searches), which is the only way to reach the
// half-run-ladder refusal.
const ladderCandidatesAfterFirst = () =>
  vi.fn(async (bs: { brewery: string; name: string }[]) =>
    bs.map((b, i) => ({
      brewery: b.brewery,
      name: b.name,
      eligible: true,
      algolia: rung(`q:${b.name}`),
      ...(i === 0 ? {} : { algoliaNarrow: rung(`n:${b.name}`) }),
    })),
  );

const zeroHits = () => vi.fn(async () => ({ hits: [] as { bid: number }[] }));

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
    // #391: and a 5th — the ladder rung that actually produced the hits.
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
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
      { abv: 0, style: 'Kwas Chlebowy' }, 'q:Kwas Chlebowy Jasny',
    );
  });

  it('omits absent facts rather than sending undefined keys', async () => {
    const d = deps();
    await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0' }], d);
    expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0' }]);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
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
      { bid: 6648348, bidSlug: 'mad-brew-tomatol-bulgogi', brand: 'Mad Brew' }, 'q:Tomatol Bulgogi',
    );
  });

  it('sends no slug or brand when the shop published no bid', async () => {
    const d = deps();
    await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0', bidSlug: 'stray' }], d);
    expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0' }]);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
  });

  // runEnrichment is exported: a bid the server's schema would reject (non-positive,
  // fractional, NaN) must be dropped here rather than 400 the whole relay.
  it.each([['zero', 0], ['negative', -5], ['fractional', 1.5], ['NaN', NaN], ['Infinity', Infinity]])(
    'drops a %s bid from both endpoints',
    async (_label, bad) => {
      const d = deps();
      await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0', bid: bad, bidSlug: 's' }], d);
      expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0' }]);
      expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
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
      expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
    },
  );

  it('keeps a legitimate 0', async () => {
    const d = deps();
    await runEnrichment([{ key: 'k0', brewery: 'B', name: 'N0', abv: 0 }], d);
    expect(d.getCandidates).toHaveBeenCalledWith([{ brewery: 'B', name: 'N0', abv: 0 }]);
  });
});

// #391: the relay half of the #382 ladder. The narrow rung runs first; the wide rung is a
// fallback for a ZERO-HIT narrow response and for nothing else.
describe('runEnrichment query ladder (#391)', () => {
  it('searches the narrow rung first and stops there when it returns hits', async () => {
    const fetchSearch = vi.fn(async (_q: { query: string }) => ({ hits: [{ bid: 7 }] }));
    const d = deps({ getCandidates: ladderCandidates(), fetchSearch });
    await runEnrichment(beers(1), d);
    expect(fetchSearch.mock.calls.map((c) => c[0].query)).toEqual(['n:N0']);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'n:N0');
  });

  it('widens to the wide rung only when the narrow rung returns zero hits', async () => {
    const fetchSearch = vi.fn(async (q: { query: string }) =>
      q.query.startsWith('n:') ? { hits: [] as { bid: number }[] } : { hits: [{ bid: 7 }] },
    );
    const d = deps({ getCandidates: ladderCandidates(), fetchSearch });
    await runEnrichment(beers(1), d);
    expect(fetchSearch.mock.calls.map((c) => c[0].query)).toEqual(['n:N0', 'q:N0']);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
  });

  it('does not widen after a non-empty narrow rung the server rejects', async () => {
    const fetchSearch = vi.fn(async (_q: { query: string }) => ({ hits: [{ bid: 7 }] }));
    const d = deps({
      getCandidates: ladderCandidates(),
      fetchSearch,
      submitResult: vi.fn(async (): Promise<EnrichResult> => ({ status: 'not_found' })),
    });
    await runEnrichment(beers(1), d);
    expect(fetchSearch).toHaveBeenCalledTimes(1);
    expect(d.setOrphan).toHaveBeenCalledWith('k0', 'B', 'N0');
  });

  it('reports the executed query for a single-rung beer too', async () => {
    const d = deps();
    await runEnrichment(beers(1), d);
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', { hits: [{ bid: 7 }] }, {}, 'q:N0');
  });

  it('spends the page budget on searches, not beers', async () => {
    const fetchSearch = zeroHits();
    const d = deps({ getCandidates: ladderCandidates(), fetchSearch });
    await runEnrichment(beers(MAX_SEARCHES_PER_PAGE), d); // 20 beers × 2 rungs
    expect(fetchSearch).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE); // 20 searches, 10 beers
    expect(d.submitResult).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE / 2);
    expect(d.sleep).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE - 1); // throttle between searches
  });

  it('does not submit a beer whose ladder ran out of budget mid-way', async () => {
    // Beer 0 is single-rung (1 search), beers 1..9 are two-rung (18) → 19 searches spent.
    // Beer 10 runs its narrow rung (search 20, zero hits) and has no budget to widen.
    const fetchSearch = zeroHits();
    const d = deps({ getCandidates: ladderCandidatesAfterFirst(), fetchSearch });
    await runEnrichment(beers(MAX_SEARCHES_PER_PAGE), d);

    expect(fetchSearch).toHaveBeenCalledTimes(MAX_SEARCHES_PER_PAGE);
    // 10 completed ladders submit; beer 10 (`N10`) was searched but must NOT be submitted.
    expect(d.submitResult).toHaveBeenCalledTimes(10);
    expect(d.submitResult).not.toHaveBeenCalledWith('B', 'N10', expect.anything(), expect.anything(), expect.anything());
    // It was shown as ⏳, so it must be put back to ⚪ rather than left spinning.
    expect(d.setSearching).toHaveBeenCalledWith('k10');
    expect(d.setOrphan).toHaveBeenCalledWith('k10', 'B', 'N10');
    // Beer 11 was never searched at all.
    expect(d.setSearching).not.toHaveBeenCalledWith('k11');
  });
});
