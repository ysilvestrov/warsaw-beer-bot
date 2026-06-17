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

/** Undo the overlay's marks on a card so the next run re-processes it from scratch. */
export function resetCard(el: HTMLElement): void {
  el.querySelector(`[${BADGE_MARKER}]`)?.remove();
  el.removeAttribute(SEEN_MARKER);
}

function untappdUrl(untappdId: number): string {
  return `https://untappd.com/beer/${untappdId}`;
}

// Builds the styled badge element. Clickable (opens Untappd) when untappdId is set.
function makeBadge(text: string, untappdId: number | null): HTMLElement {
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
      e.preventDefault();
      e.stopPropagation();
      window.open(untappdUrl(untappdId), '_blank', 'noopener');
    });
  }
  return badge;
}

function attach(host: HTMLElement, badge: HTMLElement): void {
  host.querySelector(`[${BADGE_MARKER}]`)?.remove();
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
}

// drunk → ✅ (+ personal rating); fuzzy-match-but-drunk → ❓ (+ global rating, uncertain);
// not-drunk with a bid + global rating → ⭐; not-drunk matched orphan (no bid) → ⚪;
// truly unmatched (matched_beer null) → no badge.
function badgeFor(result: MatchResult): HTMLElement | null {
  if (result.is_drunk) {
    return makeBadge(result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅', null);
  }
  const m = result.matched_beer;
  if (!m) return null;
  if (result.drunk_uncertain) {
    return makeBadge(m.rating_global != null ? `❓ ${m.rating_global.toFixed(1)}` : '❓', m.untappd_id);
  }
  if (m.untappd_id != null && m.rating_global != null) {
    return makeBadge(`⭐ ${m.rating_global.toFixed(1)}`, m.untappd_id);
  }
  if (m.untappd_id == null) return makeBadge('⚪', null);
  return null;
}

export function renderBadge(host: HTMLElement, result: MatchResult): void {
  if (host.querySelector(`[${BADGE_MARKER}]`)) return; // idempotent for the /match path
  const badge = badgeFor(result);
  if (badge) attach(host, badge);
}

/** Show the ⚪ orphan badge (used by enrichment before/around a search). */
export function setOrphan(host: HTMLElement): void {
  attach(host, makeBadge('⚪', null));
}

/** Replace the badge with a loading glyph while an Untappd search is in flight. */
export function setSearching(host: HTMLElement): void {
  attach(host, makeBadge('⏳', null));
}

/** Swap the badge to ⭐ + global rating once the beer is enriched. */
export function setEnriched(host: HTMLElement, untappdId: number, ratingGlobal: number | null): void {
  attach(host, makeBadge(ratingGlobal != null ? `⭐ ${ratingGlobal.toFixed(1)}` : '⭐', untappdId));
}
