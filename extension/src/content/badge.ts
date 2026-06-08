import type { MatchResult } from '../api/types';

export const BADGE_MARKER = 'data-beerbadge';

export function renderBadge(host: HTMLElement, result: MatchResult): void {
  if (!result.is_drunk) return; // MVP: only drunk beers get a badge
  if (host.querySelector(`[${BADGE_MARKER}]`)) return;

  const badge = document.createElement('div');
  badge.setAttribute(BADGE_MARKER, '');
  badge.textContent =
    result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅';
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
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
}
