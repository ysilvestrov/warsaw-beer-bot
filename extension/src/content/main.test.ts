import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startOverlay } from './main';
import { isSeen } from './badge';
import type { SiteAdapter } from '../sites/types';
import type { MatchResult } from '../api/types';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => { document.body.innerHTML = ''; });

const drunk = (): MatchResult => ({
  raw: { brewery: 'B', name: '' }, matched_beer: null, is_drunk: true, drunk_uncertain: false, user_rating: 4.2,
});

function fakeAdapter(over: Partial<SiteAdapter> = {}): SiteAdapter {
  return {
    id: 'fake',
    hostMatch: () => true,
    parseCards: (root) =>
      Array.from(root.querySelectorAll<HTMLElement>('.card')).map((el) => ({
        el, brewery: 'B', name: el.textContent ?? '',
      })),
    ...over,
  };
}

describe('startOverlay', () => {
  it('badges the first pass and re-badges after the grid is replaced', async () => {
    document.body.innerHTML = '<div class="grid"><div class="card">One</div></div>';
    const sendMatch = vi.fn(async () => [drunk()]);

    const stop = startOverlay(document, fakeAdapter(), sendMatch, { debounceMs: 10 });
    await tick(0); // let the first async pass resolve
    expect(document.querySelector('.card [data-beerbadge]')).not.toBeNull();

    // simulate AJAX navigation: replace the grid with fresh, unmarked nodes
    document.body.innerHTML = '<div class="grid"><div class="card">One</div></div>';
    const fresh = document.querySelector('.card') as HTMLElement;
    expect(isSeen(fresh)).toBe(false);
    await tick(40);
    // the observer re-ran and re-processed the fresh node (badge from cache)
    expect(isSeen(fresh)).toBe(true);
    expect(fresh.querySelector('[data-beerbadge]')).not.toBeNull();
    stop();
  });

  it('attaches the observer even when reRenderContainerSelector is absent', async () => {
    document.body.innerHTML = '<div class="card">One</div>';
    const sendMatch = vi.fn(async () => [drunk()]);
    const stop = startOverlay(document, fakeAdapter(), sendMatch, { debounceMs: 10 });
    await tick(0);
    document.body.innerHTML = '<div class="card">One</div>';
    const fresh = document.querySelector('.card') as HTMLElement;
    await tick(40);
    expect(isSeen(fresh)).toBe(true); // re-ran without a selector
    stop();
  });
});
