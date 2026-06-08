import type { Card, SiteAdapter } from './types';
import { waitForSelector } from '../content/grid-ready';

const CARD_SELECTOR = '.one-product-list-view__tile';
const BREWERY_SELECTOR = '[data-information-type="brand-name"] .one-product-tile-information__row__value';
const TITLE_SELECTOR = 'a.product__title';
// .one-product-list-view appears once per tile; .one-catalog-view-list is the single top-level
// catalog component container (count: 1) that wraps all tiles — use that for the re-render observer.
const CONTAINER_SELECTOR = '.one-catalog-view-list';

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

// The "NN,N°" token in titles is degrees Plato (extract), not ABV — used only to trim the name, never sent as abv.
function cleanName(rawTitle: string, brewery: string): string {
  let name = rawTitle;
  const b = brewery.trim();
  if (b && name.toLowerCase().startsWith(b.toLowerCase())) name = name.slice(b.length);
  // strip the degree-extract (Plato) token and everything after it ("15,0° BUT. 0,5 L").
  // Assumes ° never appears inside a beer name on this site — true for all observed titles.
  name = name.replace(/\s*\d+(?:[.,]\d+)?\s*°.*$/, '');
  // strip a trailing packaging tail when there was no degree token ("… BUT. 0,33 L")
  name = name.replace(/\s*(BUT|PUSZ|KEG|ZGRZ)\w*\.?\s*\d+(?:[.,]\d+)?\s*l\b.*$/i, '');
  return name.trim();
}

export const onemorebeer: SiteAdapter = {
  hostMatch: (url) => url.hostname === 'onemorebeer.pl' || url.hostname.endsWith('.onemorebeer.pl'),
  reRenderContainerSelector: CONTAINER_SELECTOR,

  async waitForGrid(root) {
    await waitForSelector(root, CARD_SELECTOR, { timeoutMs: 8000 });
  },

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const brewery = text(el.querySelector(BREWERY_SELECTOR));
      const rawTitle = text(el.querySelector(TITLE_SELECTOR));
      if (!brewery || !rawTitle) continue;
      const name = cleanName(rawTitle, brewery);
      if (!name) continue;
      cards.push({ el, brewery, name });
    }
    return cards;
  },
};
