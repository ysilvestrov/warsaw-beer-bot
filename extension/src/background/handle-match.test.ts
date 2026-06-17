import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { handleMatch } from './index';
import { setSettings } from '../shared/config';
import * as client from '../api/client';
import { ApiError } from '../api/client';
import type { MatchResult, RawBeer } from '../api/types';

function mkResult(name: string): MatchResult {
  return { raw: { brewery: 'B', name }, matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null };
}

beforeEach(() => setSettings({ token: 'tok', baseUrl: 'https://api.test' }));
afterEach(() => vi.restoreAllMocks());

describe('handleMatch', () => {
  it('returns no-token error when no token is set', async () => {
    await setSettings({ token: '', baseUrl: 'https://api.test' });
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'no-token' });
  });

  it('calls postMatch and returns results on success', async () => {
    const spy = vi.spyOn(client, 'postMatch').mockResolvedValue([mkResult('X')]);
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:ok', results: [mkResult('X')] });
    expect(spy).toHaveBeenCalledWith('https://api.test', 'tok', [{ brewery: 'B', name: 'X' }]);
  });

  it('chunks requests larger than 200 and concatenates results', async () => {
    const cards: RawBeer[] = Array.from({ length: 250 }, (_, i) => ({ brewery: 'B', name: `n${i}` }));
    const spy = vi
      .spyOn(client, 'postMatch')
      .mockImplementation(async (_b, _t, part) => part.map((p) => mkResult(p.name)));
    const reply = await handleMatch({ type: 'match', cards });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][2]).toHaveLength(200);
    expect(spy.mock.calls[1][2]).toHaveLength(50);
    expect(reply).toMatchObject({ type: 'match:ok' });
    if (reply.type === 'match:ok') expect(reply.results).toHaveLength(250);
  });

  it('maps ApiError code to a match:err reply', async () => {
    vi.spyOn(client, 'postMatch').mockRejectedValue(new ApiError('unauthorized'));
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'unauthorized' });
  });

  it('maps an unknown throw to code server', async () => {
    vi.spyOn(client, 'postMatch').mockRejectedValue(new Error('boom'));
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:err', code: 'server' });
  });
});
