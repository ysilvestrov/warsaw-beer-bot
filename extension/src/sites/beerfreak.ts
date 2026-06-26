import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

const CARD_SELECTOR = '.catalogCard.j-catalog-card';
const CONTAINER_SELECTOR = '[data-catalog-view-block="products"]';

interface ProductMeta {
  id: number;
  brand_title: string | null;
  title: string;
  url?: string;
}

const BREWERY_NOISE_PREFIX_RE = /^(?:brewery|brewing|browar|brouwerij|brasserie)\s+/i;
const LEADING_BREWERY_DESCRIPTORS = new Set(['brouwerij', 'brasserie', 'browar', 'pivovar', 'birrificio', 'brauerei']);
const COLLABORATOR_COMPANY_WORDS = new Set(['beer', 'brewing']);
const COLLABORATOR_TERMINAL_WORDS = new Set(['brewery', 'company', 'co', 'co.']);
const MAX_DETAIL_FETCHES_PER_PASS = 20;
const detailUrls = new WeakMap<HTMLElement, string>();
const abvByUrl = new Map<string, Promise<number | undefined>>();

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

  return stripLeadingCollaborator(rawTitle.slice(b.length))
    .replace(BREWERY_NOISE_PREFIX_RE, '')
    .trim() || rawTitle.trim();
}

function normalizedToken(token: string): string {
  return token.toLowerCase().replace(/[(),]/g, '');
}

function stripCollaboratorName(rawTitle: string): string {
  const tokens = rawTitle.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return rawTitle.trim();

  const first = normalizedToken(tokens[0]);
  if (LEADING_BREWERY_DESCRIPTORS.has(first) && tokens.length >= 3) {
    return tokens.slice(2).join(' ');
  }

  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = normalizedToken(tokens[i]);
    const next = normalizedToken(tokens[i + 1] ?? '');
    if (COLLABORATOR_COMPANY_WORDS.has(token) && COLLABORATOR_TERMINAL_WORDS.has(next)) {
      return tokens.slice(i + 2).join(' ');
    }
    if (COLLABORATOR_TERMINAL_WORDS.has(token)) {
      return tokens.slice(i + 1).join(' ');
    }
  }

  return tokens.slice(1).join(' ');
}

function stripLeadingCollaborator(rawTitle: string): string {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  const match = title.match(/^[\\/]\s*(.+)$/);
  return match ? stripCollaboratorName(match[1]) : title;
}

function splitBrandlessTitle(rawTitle: string): { brewery: string; name: string } {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  const collaborator = title.match(/^(.+?)\s*[\\/]\s*(.+)$/);
  if (collaborator) {
    return {
      brewery: collaborator[1].trim(),
      name: stripCollaboratorName(collaborator[2].trim()) || title,
    };
  }

  const tokens = title.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();

  if (tokens.length >= 3 && first && LEADING_BREWERY_DESCRIPTORS.has(first)) {
    return {
      brewery: tokens.slice(0, -1).join(' '),
      name: tokens[tokens.length - 1],
    };
  }

  if (tokens.length >= 2) {
    return {
      brewery: tokens[0],
      name: tokens.slice(1).join(' '),
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

function parseDecimal(value: string): number | undefined {
  const normalized = value.replace(',', '.').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const abv = Number(normalized);
  return Number.isFinite(abv) ? abv : undefined;
}

export function parseProductAbv(root: ParentNode): number | undefined {
  for (const row of Array.from(root.querySelectorAll('.product-features__row, tr'))) {
    const label = text(row.querySelector('.product-features__cell-title, th'));
    if (label !== 'Міцність') continue;
    const valueCell = row.querySelector('td.product-features__cell, td');
    const abv = parseDecimal(text(valueCell));
    if (abv !== undefined) return abv;
  }
  return undefined;
}

function loadAbv(url: string): Promise<number | undefined> {
  const cached = abvByUrl.get(url);
  if (cached) return cached;
  if (typeof fetch !== 'function') return Promise.resolve(undefined);

  const promise = fetch(url, { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return undefined;
      const html = await res.text();
      return parseProductAbv(new DOMParser().parseFromString(html, 'text/html'));
    })
    .catch(() => undefined);
  abvByUrl.set(url, promise);
  return promise;
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

      const parsed = product
        ? product.brand_title == null
          ? splitBrandlessTitle(rawTitle)
          : { brewery: cleanBrewery(product.brand_title), name: '' }
        : { brewery: '', name: rawTitle.trim() };
      const brewery = parsed.brewery;
      const name = parsed.name || cleanName(rawTitle, brewery);
      if (!name) continue;
      if (product?.url) detailUrls.set(el, product.url);
      cards.push({ el, brewery, name });
    }
    return cards;
  },

  async loadCardDetails(cards) {
    const limited = cards
      .filter((card) => card.abv === undefined && detailUrls.has(card.el))
      .slice(0, MAX_DETAIL_FETCHES_PER_PASS);

    await Promise.all(limited.map(async (card) => {
      const url = detailUrls.get(card.el);
      if (!url) return;
      const abv = await loadAbv(url);
      if (abv !== undefined) card.abv = abv;
    }));
  },
};
