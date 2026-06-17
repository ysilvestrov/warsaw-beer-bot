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

const untappdUrl = (untappdId: number): string => `https://untappd.com/beer/${untappdId}`;

const untappdSearchUrl = (brewery: string, name: string): string =>
  `https://untappd.com/search?q=${encodeURIComponent(`${brewery} ${name}`.trim())}&type=beer`;

// Builds the styled badge element. Clickable (opens `href` in a new tab) when href is set.
function makeBadge(text: string, href: string | null): HTMLElement {
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
    pointerEvents: href != null ? 'auto' : 'none',
    cursor: href != null ? 'pointer' : 'default',
  } as Partial<CSSStyleDeclaration>);
  if (href != null) {
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(href, '_blank', 'noopener');
    });
  }
  return badge;
}

function attach(host: HTMLElement, badge: HTMLElement): void {
  host.querySelector(`[${BADGE_MARKER}]`)?.remove();
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
}

// Guard order: drunk → ✅ (+ personal rating); truly unmatched (matched_beer null) → no
// badge; fuzzy-match-but-drunk → ❓ (+ global if present); not-drunk bid+global → ⭐;
// not-drunk matched orphan (no bid) → ⚪. All rendered badges are clickable: a bid → the
// Untappd beer page; no bid → an Untappd search prefilled with the tried brewery+name.
function badgeFor(result: MatchResult): HTMLElement | null {
  const { brewery, name } = result.raw;
  if (result.is_drunk) {
    const m = result.matched_beer;
    const href = m && m.untappd_id != null ? untappdUrl(m.untappd_id) : untappdSearchUrl(brewery, name);
    return makeBadge(result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅', href);
  }
  const m = result.matched_beer;
  if (!m) return null;
  if (result.drunk_uncertain) {
    const href = m.untappd_id != null ? untappdUrl(m.untappd_id) : untappdSearchUrl(brewery, name);
    return makeBadge(m.rating_global != null ? `❓ ${m.rating_global.toFixed(1)}` : '❓', href);
  }
  if (m.untappd_id != null && m.rating_global != null) {
    return makeBadge(`⭐ ${m.rating_global.toFixed(1)}`, untappdUrl(m.untappd_id));
  }
  if (m.untappd_id == null) return makeBadge('⚪', untappdSearchUrl(brewery, name));
  return null;
}

export function renderBadge(host: HTMLElement, result: MatchResult): void {
  if (host.querySelector(`[${BADGE_MARKER}]`)) return; // idempotent for the /match path
  const badge = badgeFor(result);
  if (badge) attach(host, badge);
}

/** Show the ⚪ orphan badge (used by enrichment); clickable to an Untappd search. */
export function setOrphan(host: HTMLElement, brewery: string, name: string): void {
  attach(host, makeBadge('⚪', untappdSearchUrl(brewery, name)));
}

/** Replace the badge with a loading glyph while an Untappd search is in flight. */
export function setSearching(host: HTMLElement): void {
  attach(host, makeBadge('⏳', null));
}

/** Swap the badge to ⭐ + global rating once the beer is enriched. */
export function setEnriched(host: HTMLElement, untappdId: number, ratingGlobal: number | null): void {
  attach(host, makeBadge(ratingGlobal != null ? `⭐ ${ratingGlobal.toFixed(1)}` : '⭐', untappdUrl(untappdId)));
}
