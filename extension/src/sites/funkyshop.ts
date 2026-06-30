import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

const CARD_SELECTOR = 'article.product-miniature';
const NON_BEER_PAGE_RE = /\/(?:pl\/17-szklomerch|en\/17-glassmerch)(?:[/?#]|$)/i;
const NON_BEER_TITLE_RE = /(?:\bset\b|szklank|kufel|pokal|glass|merch|rastal|sahm)/iu;
const VOLUME_SUFFIX_RE = /\s+(?:\(?\d+\s*x\s*)?\d+(?:[.,]\d+)?\s*(?:ml|l)\)?\s*$/i;
const ABV_RE = /(\d+(?:[.,]\d+)?)\s*%/u;

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function cleanName(raw: string): string {
  const name = raw.replace(VOLUME_SUFFIX_RE, '').trim();
  return name || raw.trim();
}

function parseAbv(raw: string): number | undefined {
  const match = raw.match(ABV_RE);
  if (!match) return undefined;
  const abv = Number(match[1].replace(',', '.'));
  return Number.isFinite(abv) ? abv : undefined;
}

function isNonBeerTitle(rawName: string, description: string): boolean {
  return isNonBeerName(rawName) || NON_BEER_TITLE_RE.test(rawName) || NON_BEER_TITLE_RE.test(description);
}

export const funkyshop: SiteAdapter = {
  id: 'funkyshop',
  hostMatch: (url) => url.hostname === 'funkyshop.pl' || url.hostname.endsWith('.funkyshop.pl'),
  reRenderContainerSelector: '#products',
  isNonBeerPage: (url) => NON_BEER_PAGE_RE.test(url.pathname),

  parseCards(root) {
    const cards: Card[] = [];

    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const rawName = text(el.querySelector('.product-title'));
      const description = text(el.querySelector('.product-description-short'));
      if (!rawName || isNonBeerTitle(rawName, description)) continue;

      const brewery = text(el.querySelector('.manufacturer-product'));
      const name = cleanName(rawName);
      if (!name) continue;

      const abv = parseAbv(description);
      cards.push(abv == null ? { el, brewery, name } : { el, brewery, name, abv });
    }

    return cards;
  },
};
