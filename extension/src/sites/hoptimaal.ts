import type { Card, SiteAdapter } from './types';

const CARD_SELECTOR = '.product-item';
const NON_BEER_COLLECTION_RE = /\/collections\/(?:abonnement|beer-club|beer-packages|bundles|merch|spirits)(?:\/|$)/i;
const ABV_RE = /(?:^|\|)\s*([0-9]+(?:[.,][0-9]+)?)\s*%/;
const BREWERY_SUFFIX_RE = /\b(?:barrel brewing|brewing company|brewing co\.?|brewing|brewery|brouwerij|brasserie|cervejaria)\b/i;
const LEADING_BREWERY_DESCRIPTOR_RE = /^(?:brouwerij|brasserie|cervejaria|browar|pivovar|birrificio|brauerei)\s+\S+/i;
const LEADING_ARTICLES = new Set(['de', 'het', 'la', 'le', 'les', 'the']);

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function parseAbv(raw: string): number | undefined {
  const match = raw.match(ABV_RE);
  if (!match) return undefined;
  const parsed = Number(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalize(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanBeerName(raw: string): string {
  return raw.replace(/^\s*[-–—:]\s*/, '').trim();
}

function productUrl(el: HTMLElement, titleLink: Element | null): string {
  return el.getAttribute('data-url') ?? titleLink?.getAttribute('href') ?? '';
}

function isNonBeerCard(el: HTMLElement, titleLink: Element | null): boolean {
  return NON_BEER_COLLECTION_RE.test(productUrl(el, titleLink));
}

function vendorNames(root: ParentNode): string[] {
  const vendors = new Set<string>();
  for (const input of Array.from(root.querySelectorAll<HTMLElement>('input[data-filter^="filter.p.vendor="]'))) {
    const raw = input.getAttribute('data-filter')?.slice('filter.p.vendor='.length).trim();
    if (raw) vendors.add(raw);
  }
  return Array.from(vendors).sort((a, b) => b.length - a.length);
}

function splitByVendor(title: string, vendors: string[]): { brewery: string; name: string } | null {
  const normalizedTitle = normalize(title);
  for (const vendor of vendors) {
    const normalizedVendor = normalize(vendor);
    if (normalizedTitle === normalizedVendor) return null;
    if (normalizedTitle.startsWith(`${normalizedVendor} `)) {
      return { brewery: vendor, name: cleanBeerName(title.slice(vendor.length)) };
    }
  }
  return null;
}

function splitByDescriptor(title: string): { brewery: string; name: string } {
  const leading = title.match(LEADING_BREWERY_DESCRIPTOR_RE);
  if (leading && leading[0].length < title.length) {
    return { brewery: leading[0], name: cleanBeerName(title.slice(leading[0].length)) };
  }

  const suffix = title.match(BREWERY_SUFFIX_RE);
  if (suffix && suffix.index != null) {
    const end = suffix.index + suffix[0].length;
    if (end < title.length) return { brewery: title.slice(0, end).trim(), name: cleanBeerName(title.slice(end)) };
  }

  const tokens = title.split(/\s+/).filter(Boolean);
  const prefixSize = LEADING_ARTICLES.has(tokens[0]?.toLowerCase() ?? '') ? 3 : 1;
  if (tokens.length > prefixSize) {
    return {
      brewery: tokens.slice(0, prefixSize).join(' '),
      name: cleanBeerName(tokens.slice(prefixSize).join(' ')),
    };
  }

  return { brewery: title, name: title };
}

function splitTitle(title: string, vendors: string[]): { brewery: string; name: string } {
  return splitByVendor(title, vendors) ?? splitByDescriptor(title);
}

export const hoptimaal: SiteAdapter = {
  id: 'hoptimaal',
  hostMatch: (url) => url.hostname === 'hoptimaal.com' || url.hostname.endsWith('.hoptimaal.com'),
  reRenderContainerSelector: '.collection__products',

  parseCards(root) {
    const cards: Card[] = [];
    const vendors = vendorNames(root);
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const titleLink = el.querySelector('.product-item__product-title a');
      if (isNonBeerCard(el, titleLink)) continue;

      const title = text(titleLink) || el.getAttribute('data-title')?.trim() || '';
      if (!title) continue;

      const parsed = splitTitle(title, vendors);
      if (!parsed.name) continue;

      const abv = parseAbv(text(el.querySelector('.product-item__subtitle')));
      cards.push({ el, brewery: parsed.brewery, name: parsed.name, ...(abv == null ? {} : { abv }) });
    }
    return cards;
  },
};
