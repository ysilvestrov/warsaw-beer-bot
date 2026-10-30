import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleMatch } from './index';
import * as matcher from '../untappd/matcher';
import type { MatchResult } from '../api/types';

function mkResult(name: string): MatchResult {
  return {
    raw: { brewery: 'B', name },
    matched_beer: { id: 1, brewery: 'B', name, rating_global: 4.1, untappd_id: 101 },
    is_drunk: true,
    drunk_uncertain: false,
    user_rating: 4.25,
    source: 'exact',
    searched: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleMatch', () => {
  it('calls matchLocalCards and returns match:ok on success', async () => {
    const spy = vi.spyOn(matcher, 'matchLocalCards').mockResolvedValue([mkResult('IPA')]);
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'IPA' }] });

    expect(spy).toHaveBeenCalledWith([{ brewery: 'B', name: 'IPA' }]);
    expect(reply).toEqual({
      type: 'match:ok',
      results: [mkResult('IPA')],
    });
  });

  it('catches matcher errors and returns match:err', async () => {
    vi.spyOn(matcher, 'matchLocalCards').mockRejectedValue(new Error('IndexedDB failure'));
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'IPA' }] });

    expect(reply).toEqual({
      type: 'match:err',
      code: 'server',
    });
  });
});
