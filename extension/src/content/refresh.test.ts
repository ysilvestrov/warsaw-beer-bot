import { describe, it, expect } from 'vitest';
import { refreshCards } from './refresh';
import { renderBadge, markSeen, isSeen, BADGE_MARKER } from './badge';
import { normalizeKey } from '../shared/normalize';
import type { SiteAdapter } from '../sites/types';

function cardEl(): HTMLElement {
  const el = document.createElement('div');
  renderBadge(el, { is_drunk: true, user_rating: 4, raw: { brewery: 'x', name: 'y' }, matched_beer: null });
  markSeen(el);
  return el;
}

describe('refreshCards', () => {
  it('resets every parsed card and returns its cache key', () => {
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

    const keys = refreshCards(document, adapter);

    expect(keys).toEqual([normalizeKey('PINTA', 'Atak Chmielu'), normalizeKey('Track', 'Sonoma')]);
    expect(a.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
    expect(isSeen(a)).toBe(false);
    expect(isSeen(b)).toBe(false);
  });
});
