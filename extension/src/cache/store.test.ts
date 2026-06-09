import { describe, it, expect } from 'vitest';
import { getCached, setCached, CACHE_TTL_MS } from './store';
import type { MatchResult } from '../api/types';

const sample: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
  is_drunk: true,
  user_rating: 4.0,
};

describe('cache/store', () => {
  it('returns null for a missing key', async () => {
    expect(await getCached('pinta|hazy morning')).toBeNull();
  });

  it('stores and reads back within TTL', async () => {
    const now = 1_000_000;
    await setCached('pinta|hazy morning', sample, now);
    expect(await getCached('pinta|hazy morning', now + 1000)).toEqual(sample);
  });

  it('treats entries older than TTL as misses', async () => {
    const now = 1_000_000;
    await setCached('pinta|hazy morning', sample, now);
    expect(await getCached('pinta|hazy morning', now + CACHE_TTL_MS + 1)).toBeNull();
  });
});
