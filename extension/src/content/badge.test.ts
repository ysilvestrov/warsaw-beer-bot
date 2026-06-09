import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderBadge, BADGE_MARKER, markSeen, isSeen, SEEN_MARKER } from './badge';
import type { MatchResult } from '../api/types';

function el(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

const drunk = (userRating: number | null): MatchResult => ({
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
  is_drunk: true,
  user_rating: userRating,
});

const notDrunkRated: MatchResult = {
  raw: { brewery: 'PINTA', name: 'New One' },
  matched_beer: { id: 2, name: 'New One', brewery: 'PINTA', rating_global: 3.9, untappd_id: 222 },
  is_drunk: false,
  user_rating: null,
};

const notDrunkOrphan: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Orphan' },
  matched_beer: { id: 3, name: 'Orphan', brewery: 'PINTA', rating_global: null, untappd_id: null },
  is_drunk: false,
  user_rating: null,
};

const unmatched: MatchResult = {
  raw: { brewery: 'Nowhere', name: 'Ghost' },
  matched_beer: null,
  is_drunk: false,
  user_rating: null,
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('renderBadge', () => {
  it('adds a ✅ + personal rating badge for a drunk beer', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    const badge = host.querySelector(`[${BADGE_MARKER}]`);
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('✅');
    expect(badge!.textContent).toContain('4.0');
  });

  it('shows just ✅ when drunk with no personal rating', () => {
    const host = el();
    renderBadge(host, drunk(null));
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('✅');
  });

  it('adds a ⭐ + global rating badge for a not-drunk catalog beer with a bid', () => {
    const host = el();
    renderBadge(host, notDrunkRated);
    const badge = host.querySelector(`[${BADGE_MARKER}]`);
    expect(badge!.textContent).toContain('⭐');
    expect(badge!.textContent).toContain('3.9');
  });

  it('renders nothing for a not-drunk orphan (no bid / no global rating)', () => {
    const host = el();
    renderBadge(host, notDrunkOrphan);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('renders nothing for an unmatched beer', () => {
    const host = el();
    renderBadge(host, unmatched);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('opens the Untappd beer page on click and suppresses card navigation', () => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderBadge(host, notDrunkRated);
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    const notPrevented = badge.dispatchEvent(evt);
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
    expect(notPrevented).toBe(false); // preventDefault() was called
  });

  it('is idempotent — does not double-render', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    renderBadge(host, drunk(4.0));
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`).length).toBe(1);
  });
});

describe('seen marker', () => {
  it('marks and detects a processed element', () => {
    const host = document.createElement('div');
    expect(isSeen(host)).toBe(false);
    markSeen(host);
    expect(host.hasAttribute(SEEN_MARKER)).toBe(true);
    expect(isSeen(host)).toBe(true);
  });
});
