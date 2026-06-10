import type { Card, SiteAdapter } from './types';

const CARD_SELECTOR = '.product-block';

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function splitTitle(rawTitle: string): { brewery: string; name: string } | null {
  const title = rawTitle.trim();
  if (!title) return null;

  const separator = title.indexOf(' - ');
  if (separator < 0) return { brewery: '', name: title };

  const brewery = title.slice(0, separator).trim();
  const name = title.slice(separator + 3).trim();
  if (!name) return null;
  return { brewery, name };
}

export const bierloods22: SiteAdapter = {
  id: 'bierloods22',
  hostMatch: (url) => url.hostname === 'bierloods22.nl' || url.hostname.endsWith('.bierloods22.nl'),
  reRenderContainerSelector: '#collection-container',

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const parsed = splitTitle(text(el.querySelector('a.title')));
      if (!parsed) continue;
      cards.push({ el, brewery: parsed.brewery, name: parsed.name });
    }
    return cards;
  },
};
