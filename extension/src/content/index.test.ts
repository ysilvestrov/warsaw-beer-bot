import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOverlay } from './index';
import { BADGE_MARKER, isSeen } from './badge';
import { setCached } from '../cache/store';
import { normalizeKey } from '../shared/normalize';
import type { SiteAdapter, Card } from '../sites/types';
import type { MatchResult, RawBeer } from '../api/types';

function drunkResult(brewery: string, name: string): MatchResult {
  return {
    raw: { brewery, name },
    matched_beer: { id: 1, name, brewery, rating_global: 4.0, untappd_id: 111 },
    is_drunk: true,
    drunk_uncertain: false,
    user_rating: 4.2,
  };
}

function cardEl(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

beforeEach(() => { document.body.innerHTML = ''; });

function adapterFor(cards: Card[]): SiteAdapter {
  return { id: 'test', hostMatch: () => true, parseCards: () => cards };
}

describe('runOverlay', () => {
  it('matches uncached cards via sendMatch and badges drunk ones', async () => {
    const cards: Card[] = [{ el: cardEl(), brewery: 'PINTA', name: 'Hazy Morning' }];
    const sendMatch = vi.fn(async (_b: RawBeer[]) => [drunkResult('PINTA', 'Hazy Morning')]);

    await runOverlay(document, adapterFor(cards), sendMatch);

    expect(sendMatch).toHaveBeenCalledTimes(1);
    expect(cards[0].el.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
  });

  it('uses the cache and does not call sendMatch for cached cards', async () => {
    const card: Card = { el: cardEl(), brewery: 'PINTA', name: 'Hazy Morning' };
    await setCached(normalizeKey('PINTA', 'Hazy Morning'), drunkResult('PINTA', 'Hazy Morning'));
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapterFor([card]), sendMatch);

    expect(sendMatch).not.toHaveBeenCalled();
    expect(card.el.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
  });

  it('awaits waitForGrid before parsing when the adapter defines it', async () => {
    const order: string[] = [];
    const card: Card = { el: cardEl(), brewery: 'B', name: 'N' };
    const adapter: SiteAdapter = {
      id: 'test',
      hostMatch: () => true,
      waitForGrid: async () => { order.push('wait'); },
      parseCards: () => { order.push('parse'); return [card]; },
    };
    await runOverlay(document, adapter, async () => [drunkResult('B', 'N')]);
    expect(order).toEqual(['wait', 'parse']);
  });

  it('does not throw when sendMatch fails (graceful skip)', async () => {
    const card: Card = { el: cardEl(), brewery: 'B', name: 'N' };
    const sendMatch = vi.fn(async () => { throw new Error('offline'); });
    await expect(runOverlay(document, adapterFor([card]), sendMatch)).resolves.toBeUndefined();
    expect(card.el.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('marks every parsed card element seen, drunk or not', async () => {
    const a = cardEl();
    const b = cardEl();
    const notDrunk: MatchResult = {
      raw: { brewery: 'X', name: 'Two' }, matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null,
    };
    const adapter = adapterFor([
      { el: a, brewery: 'X', name: 'One' },
      { el: b, brewery: 'X', name: 'Two' },
    ]);
    const sendMatch = async () => [drunkResult('X', 'One'), notDrunk];

    await runOverlay(document, adapter, sendMatch);

    expect(isSeen(a)).toBe(true);
    expect(isSeen(b)).toBe(true);
  });

  it('passes not-drunk no-untappd_id beers to the enrich callback', async () => {
    const a = cardEl();
    const orphan: MatchResult = {
      raw: { brewery: 'B', name: 'Orphan One' },
      matched_beer: { id: 1, name: 'Orphan One', brewery: 'B', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null,
    };
    const adapter = adapterFor([{ el: a, brewery: 'B', name: 'Orphan One' }]);
    const sendMatch = async () => [orphan];
    const enrich = vi.fn();
    await runOverlay(document, adapter, sendMatch, enrich);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich.mock.calls[0][0][0]).toMatchObject({ brewery: 'B', name: 'Orphan One' });
  });
});
