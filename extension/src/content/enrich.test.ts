import { describe, it, expect, vi } from 'vitest';
import { runEnrichment, MAX_SEARCHES_PER_PAGE, type EnrichDeps } from './enrich';
import type { EnrichResult } from '../api/types';

function deps(over: Partial<EnrichDeps> = {}): EnrichDeps {
  return {
    getCandidates: vi.fn(async (beers: { brewery: string; name: string }[]) =>
      beers.map((b) => ({ brewery: b.brewery, name: b.name, eligible: true, searchUrl: `u:${b.name}` })),
    ),
    fetchSearch: vi.fn(async () => '<raw>'),
    trim: vi.fn(() => '<small>'),
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
    expect(d.submitResult).toHaveBeenCalledWith('B', 'N0', '<small>');
    expect(d.setSearching).toHaveBeenCalledTimes(2);
    expect(d.setEnriched).toHaveBeenCalledWith('k0', 7, 4.0);
    expect(d.sleep).toHaveBeenCalledTimes(1); // between the two
  });

  it('skips ineligible beers', async () => {
    const d = deps({
      getCandidates: vi.fn(async (bs: { brewery: string; name: string }[]) =>
        bs.map((b) => ({ brewery: b.brewery, name: b.name, eligible: false, searchUrl: 'u' })),
      ),
    });
    await runEnrichment(beers(2), d);
    expect(d.fetchSearch).not.toHaveBeenCalled();
  });

  it('on not_found, clears the loader back to ⚪ and does not enrich', async () => {
    const d = deps({ submitResult: vi.fn(async (): Promise<EnrichResult> => ({ status: 'not_found' })) });
    await runEnrichment(beers(1), d);
    expect(d.setEnriched).not.toHaveBeenCalled();
    expect(d.setOrphan).toHaveBeenCalledWith('k0');
  });
});
