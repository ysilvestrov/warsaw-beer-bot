import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

function text(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

export const beerrepublic: SiteAdapter = {
  id: 'beerrepublic',
  hostMatch: (url) => url.hostname === 'beerrepublic.eu' || url.hostname.endsWith('.beerrepublic.eu'),
  reRenderContainerSelector: 'section[data-section-type="collection"]',

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.product-item'))) {
      const name = text(el.querySelector('.product-item__title'));
      if (!name) continue;
      if (isNonBeerName(name)) continue;
      const brewery = text(el.querySelector('.product-item__vendor'));
      cards.push({ el, brewery, name });
    }
    return cards;
  },
};
