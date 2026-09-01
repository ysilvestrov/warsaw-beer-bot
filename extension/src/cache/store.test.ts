import { describe, it, expect } from 'vitest';
import { getCached, setCached, CACHE_TTL_MS, clearKeys, clearAll, countAll } from './store';
import type { MatchResult } from '../api/types';

const sample: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
  is_drunk: true,
  drunk_uncertain: false,
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

  it('clearKeys removes only the given keys', async () => {
    await setCached('a|x', sample);
    await setCached('b|y', sample);
    await clearKeys(['a|x']);
    expect(await getCached('a|x')).toBeNull();
    expect(await getCached('b|y')).toEqual(sample);
  });

  it('clearKeys is a no-op for an empty list', async () => {
    await setCached('a|x', sample);
    await clearKeys([]);
    expect(await getCached('a|x')).toEqual(sample);
  });

  it('clearAll removes every cached entry', async () => {
    await setCached('a|x', sample);
    await setCached('b|y', sample);
    await clearAll();
    expect(await getCached('a|x')).toBeNull();
    expect(await getCached('b|y')).toBeNull();
  });

  it('clearAll leaves non-cache (non-mc2:) storage untouched', async () => {
    await chrome.storage.local.set({ token: 'keep-me' });
    await setCached('a|x', sample);
    await clearAll();
    expect(await getCached('a|x')).toBeNull();
    expect((await chrome.storage.local.get('token')).token).toBe('keep-me');
  });

  it('countAll counts our entries and leaves them alone', async () => {
    await setCached('a|x', sample);
    await setCached('b|y', sample);
    await chrome.storage.local.set({ 'unrelated:key': 1 });
    expect(await countAll()).toBe(2);
    expect(await getCached('a|x')).toEqual(sample);
  });

  it('countAll is 0 on an empty cache', async () => {
    await chrome.storage.local.set({ 'unrelated:key': 1 });
    expect(await countAll()).toBe(0);
  });

  it('clearAll returns how many entries it removed', async () => {
    await setCached('a|x', sample);
    await setCached('b|y', sample);
    expect(await clearAll()).toBe(2);
    expect(await clearAll()).toBe(0);
  });
});
