import { describe, it, expect, beforeEach } from 'vitest';
import { renderBadge, BADGE_MARKER } from './badge';
import type { MatchResult } from '../api/types';

function el(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

const drunk = (userRating: number | null): MatchResult => ({
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1 },
  is_drunk: true,
  user_rating: userRating,
});

const notDrunk: MatchResult = {
  raw: { brewery: 'PINTA', name: 'New One' },
  matched_beer: { id: 2, name: 'New One', brewery: 'PINTA', rating_global: 3.9 },
  is_drunk: false,
  user_rating: null,
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('renderBadge', () => {
  it('adds a ✅ + rating badge for a drunk beer', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    const badge = host.querySelector(`[${BADGE_MARKER}]`);
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('✅');
    expect(badge!.textContent).toContain('4.0');
  });

  it('shows just ✅ when no personal rating', () => {
    const host = el();
    renderBadge(host, drunk(null));
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('✅');
  });

  it('renders nothing for a not-drunk beer (MVP)', () => {
    const host = el();
    renderBadge(host, notDrunk);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('is idempotent — does not double-render', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    renderBadge(host, drunk(4.0));
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`).length).toBe(1);
  });
});
