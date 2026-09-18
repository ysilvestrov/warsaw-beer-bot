import { describe, it, expect } from 'vitest';
import { refreshCards } from './refresh';
import { renderBadge, markSeen, isSeen, BADGE_MARKER, setNonBeer } from './badge';
import { normalizeKey } from '../shared/normalize';
import type { SiteAdapter } from '../sites/types';

function cardEl(): HTMLElement {
  const el = document.createElement('div');
  renderBadge(el, { is_drunk: true, drunk_uncertain: false, user_rating: 4, source: null, searched: true, raw: { brewery: 'x', name: 'y' }, matched_beer: null });
  markSeen(el);
  return el;
}

describe('refreshCards', () => {
  it('resets every parsed card and returns its cache key', async () => {
    const a = cardEl();
    const b = cardEl();
    const adapter = {
      id: 'fake',
      hostMatch: () => true,
      parseCards: () => [
        { el: a, brewery: 'PINTA', name: 'Atak Chmielu' },
        { el: b, brewery: 'Track', name: 'Sonoma' },
      ],
    } as unknown as SiteAdapter;

    const keys = await refreshCards(document, adapter);

    expect(keys).toEqual([normalizeKey('PINTA', 'Atak Chmielu'), normalizeKey('Track', 'Sonoma')]);
    expect(a.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
    expect(isSeen(a)).toBe(false);
    expect(isSeen(b)).toBe(false);
    expect(b.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('resets a confirmed non-beer without returning a cache key', async () => {
    const host = cardEl();
    const adapter = {
      id: 'fake',
      hostMatch: () => true,
      parseCards: () => [{
        el: host,
        brewery: '',
        name: '',
        nonBeer: true,
        skip: true,
      }],
    } as SiteAdapter;

    const keys = await refreshCards(document, adapter);

    expect(keys).toEqual([]);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
    expect(isSeen(host)).toBe(false);
  });

  it('does not return a cache key for a detail-classified non-beer', async () => {
    const host = cardEl();
    const adapter = {
      id: 'fake',
      hostMatch: () => true,
      loadDetailsBeforeCache: true,
      parseCards: () => [{ el: host, brewery: 'Flasker', name: 'Gift set' }],
      loadCardDetails: async (cards: { nonBeer?: boolean }[]) => { cards[0].nonBeer = true; },
    } as SiteAdapter;

    expect(await refreshCards(document, adapter)).toEqual([]);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
    expect(isSeen(host)).toBe(false);
  });

  it('returns a cache key for a detail-skipped card with an existing identity', async () => {
    const host = cardEl();
    const adapter = {
      id: 'fake',
      hostMatch: () => true,
      loadDetailsBeforeCache: true,
      parseCards: () => [{ el: host, brewery: 'Flasker', name: 'Unverified item', skip: true }],
      loadCardDetails: async () => {},
    } as SiteAdapter;

    expect(await refreshCards(document, adapter)).toEqual([normalizeKey('Flasker', 'Unverified item')]);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
    expect(isSeen(host)).toBe(false);
  });

  it('returns a fresh beer key when a reused card still has a non-beer badge', async () => {
    const host = cardEl();
    setNonBeer(host);
    const adapter = {
      id: 'fake',
      hostMatch: () => true,
      parseCards: () => [{ el: host, brewery: 'PINTA', name: 'Hazy Morning' }],
    } as SiteAdapter;

    expect(await refreshCards(document, adapter)).toEqual([normalizeKey('PINTA', 'Hazy Morning')]);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });
});
