import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

const CARD_SELECTOR = 'article.product-miniature';
const NON_BEER_PAGE_RE = /\/(?:pl\/17-szklomerch|en\/17-glassmerch)(?:[/?#]|$)/i;
const NON_BEER_TITLE_RE = /(?:\bset\b|szklank|kufel|pokal|glass|merch|rastal|sahm|\bcan\s+deposit\b|\bdeposit\s+fee\b)/iu;
const VOLUME_SUFFIX_RE = /\s+(?:\(?\d+\s*x\s*)?\d+(?:[.,]\d+)?\s*(?:ml|l)\)?(?:\s*\([^)]*\))?\s*$/i;
const ABV_RE = /(\d+(?:[.,]\d+)?)\s*%/u;
const MAX_DETAIL_FETCHES_PER_PASS = 20;
const detailUrls = new WeakMap<HTMLElement, string>();
const breweryByUrl = new Map<string, Promise<string | undefined>>();

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

function absoluteUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, 'https://funkyshop.pl').href;
  } catch {
    return undefined;
  }
}

function loadBrewery(url: string): Promise<string | undefined> {
  const cached = breweryByUrl.get(url);
  if (cached) return cached;
  if (typeof fetch !== 'function') return Promise.resolve(undefined);

  const promise = fetch(url, { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return undefined;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return text(doc.querySelector('.manufacturer-product')) || undefined;
    })
    .catch(() => undefined);
  breweryByUrl.set(url, promise);
  return promise;
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
      const url = absoluteUrl(el.querySelector<HTMLAnchorElement>('.product-title a')?.getAttribute('href'));
      if (!brewery && url) detailUrls.set(el, url);
      cards.push(abv == null ? { el, brewery, name } : { el, brewery, name, abv });
    }

    return cards;
  },

  async loadCardDetails(cards) {
    const limited = cards
      .filter((card) => !card.brewery && detailUrls.has(card.el))
      .slice(0, MAX_DETAIL_FETCHES_PER_PASS);

    await Promise.all(limited.map(async (card) => {
      const url = detailUrls.get(card.el);
      if (!url) return;
      const brewery = await loadBrewery(url);
      if (brewery) {
        card.brewery = brewery;
      } else {
        card.skip = true;
      }
    }));
  },
};
