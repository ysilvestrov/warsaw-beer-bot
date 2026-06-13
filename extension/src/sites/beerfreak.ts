import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

const CARD_SELECTOR = '.catalogCard.j-catalog-card';
const CONTAINER_SELECTOR = '[data-catalog-view-block="products"]';

interface ProductMeta {
  id: number;
  brand_title: string | null;
  title: string;
}

const BREWERY_NOISE_PREFIX_RE = /^(?:brewery|brewing|browar|brouwerij|brasserie)\s+/i;
const LEADING_BREWERY_DESCRIPTORS = new Set(['brouwerij', 'brasserie', 'browar', 'pivovar', 'birrificio', 'brauerei']);

function text(el: Element | null): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function cleanBrewery(raw: string | null): string {
  return (raw ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(rawTitle: string, brewery: string): string {
  const b = brewery.trim();
  if (!b) return rawTitle.trim();

  const prefix = rawTitle.slice(0, b.length);
  if (prefix.toLowerCase() !== b.toLowerCase()) return rawTitle.trim();

  return rawTitle.slice(b.length).trim().replace(BREWERY_NOISE_PREFIX_RE, '').trim() || rawTitle.trim();
}

function splitBrandlessTitle(rawTitle: string): { brewery: string; name: string } {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  const tokens = title.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();

  if (tokens.length >= 3 && first && LEADING_BREWERY_DESCRIPTORS.has(first)) {
    return {
      brewery: tokens.slice(0, -1).join(' '),
      name: tokens[tokens.length - 1],
    };
  }

  return { brewery: '', name: title };
}

function ownerDocument(root: ParentNode): Document | null {
  return root instanceof Document ? root : root.ownerDocument;
}

function productMeta(root: ParentNode): Map<number, ProductMeta> {
  const doc = ownerDocument(root);
  if (!doc) return new Map();
  const scripts = Array.from(doc.querySelectorAll('script'));
  for (const script of scripts) {
    const source = script.textContent ?? '';
    const match = source.match(/products\s*=\s*(\[[\s\S]*?\])\s*,\s*ids\s*=/);
    if (!match) continue;

    try {
      const rows = JSON.parse(match[1]) as ProductMeta[];
      return new Map(rows.map((row) => [row.id, row]));
    } catch {
      return new Map();
    }
  }
  return new Map();
}

export const beerfreak: SiteAdapter = {
  id: 'beerfreak',
  hostMatch: (url) => url.hostname === 'beerfreak.org' || url.hostname.endsWith('.beerfreak.org'),
  reRenderContainerSelector: CONTAINER_SELECTOR,

  parseCards(root) {
    const meta = productMeta(root);
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const id = Number(el.querySelector<HTMLElement>('.j-product-container')?.dataset.id);
      const product = Number.isFinite(id) ? meta.get(id) : undefined;
      const rawTitle = product?.title ?? text(el.querySelector('.catalogCard-title a'));
      if (!rawTitle) continue;
      if (isNonBeerName(rawTitle)) continue;

      const parsed = product?.brand_title == null
        ? splitBrandlessTitle(rawTitle)
        : { brewery: cleanBrewery(product.brand_title), name: '' };
      const brewery = parsed.brewery;
      const name = parsed.name || cleanName(rawTitle, brewery);
      if (!name) continue;
      cards.push({ el, brewery, name });
    }
    return cards;
  },
};
