import type { MatchResult } from '../api/types';

export const BADGE_MARKER = 'data-beerbadge';
export const SEEN_MARKER = 'data-beerseen';

/** Mark a card element as processed by the overlay (badged or not). */
export function markSeen(el: HTMLElement): void {
  el.setAttribute(SEEN_MARKER, '');
}

/** True if the overlay has already processed this card element. */
export function isSeen(el: HTMLElement): boolean {
  return el.hasAttribute(SEEN_MARKER);
}

function untappdUrl(untappdId: number): string {
  return `https://untappd.com/beer/${untappdId}`;
}

// The badge label, or null when this result should not be badged.
// drunk → ✅ (+ personal rating; the ✅ shows the user's own data, independent of the
// catalog match); in-catalog & not drunk with a bid + global rating → ⭐ (global
// rating); everything else (orphan / unmatched) → no badge.
function badgeText(result: MatchResult): string | null {
  if (result.is_drunk) {
    return result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅';
  }
  const m = result.matched_beer;
  if (m && m.untappd_id != null && m.rating_global != null) {
    return `⭐ ${m.rating_global.toFixed(1)}`;
  }
  return null;
}

export function renderBadge(host: HTMLElement, result: MatchResult): void {
  const text = badgeText(result);
  if (text == null) return;
  if (host.querySelector(`[${BADGE_MARKER}]`)) return;

  const untappdId = result.matched_beer?.untappd_id ?? null;

  const badge = document.createElement('div');
  badge.setAttribute(BADGE_MARKER, '');
  badge.textContent = text;
  Object.assign(badge.style, {
    position: 'absolute',
    top: '4px',
    right: '4px',
    zIndex: '2147483647',
    background: 'rgba(20,20,20,0.82)',
    color: '#fff',
    font: '600 12px/1 system-ui, sans-serif',
    padding: '3px 6px',
    borderRadius: '6px',
    pointerEvents: untappdId != null ? 'auto' : 'none',
    cursor: untappdId != null ? 'pointer' : 'default',
  } as Partial<CSSStyleDeclaration>);

  if (untappdId != null) {
    badge.addEventListener('click', (e) => {
      // The badge sits on top of the product card, which is usually itself a
      // link — suppress the card's navigation before opening Untappd.
      e.preventDefault();
      e.stopPropagation();
      window.open(untappdUrl(untappdId), '_blank', 'noopener');
    });
  }

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
}
