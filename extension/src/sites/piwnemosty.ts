import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

interface ItemMeta {
  item_id?: string;
  item_name?: string;
  item_brand?: string;
  item_category?: string;
  item_category2?: string;
}

const CARD_SELECTOR = '#search .product[data-product_id]';
const NON_BEER_PAGE_RE = /\/pol_m_(?:PRZEKASKI|SZKLO-I-MERCH)(?:[-_/]|$)/i;
const NON_BEER_TITLE_RE = /\b(?:bon podarunkowy|chipsy|orzeszki|paluchy|plecak|shaker|szkło|t-shirt|torba)\b/i;
const PACKAGING_SUFFIX_RE = /\s+-\s+(?:butelka|puszka)\s+\d+\s*ml\s*$/i;
const BROWAR_PREFIX_RE = /^browar\s+/i;
const OUT_OF_STOCK_MARKER_RE = /\bchwilowy\s+brak\s*:?\s*\(?|\bwypite\b/gi;
const PLACEHOLDER_BREWERY_RE = /^-$/;

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function normalize(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

function brandName(raw: string): string {
  return raw.replace(BROWAR_PREFIX_RE, '').trim();
}

function tidy(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/^[\s:()\-]+|[\s:()\-]+$/g, '').trim();
}

function stripOutOfStockMarkers(raw: string): string {
  const stripped = raw.replace(OUT_OF_STOCK_MARKER_RE, ' ');
  return stripped === raw ? raw.replace(/\s+/g, ' ').trim() : tidy(stripped);
}

function cleanBrewery(raw: string | undefined): string {
  const value = raw ?? '';
  const stripped = value.replace(OUT_OF_STOCK_MARKER_RE, ' ');
  const brewery = stripped === value ? value.replace(/\s+/g, ' ').trim() : tidy(stripped);
  if (stripped !== value && /^brewery$/i.test(brewery)) return '';
  return PLACEHOLDER_BREWERY_RE.test(brewery) ? '' : brewery;
}

function itemMetadata(root: ParentNode): Map<string, ItemMeta> {
  const out = new Map<string, ItemMeta>();
  for (const script of Array.from(root.querySelectorAll('script'))) {
    const raw = script.textContent ?? '';
    if (!raw.includes('view_item_list')) continue;

    const match = raw.match(/gtag\("event",\s*"view_item_list",\s*(\{[\s\S]*\})\);?/);
    if (!match) continue;

    try {
      const parsed = JSON.parse(match[1]) as { items?: ItemMeta[] };
      for (const item of parsed.items ?? []) {
        if (item.item_id) out.set(String(item.item_id), item);
      }
    } catch {
      // Product cards remain parseable from visible DOM if analytics metadata changes.
    }
  }
  return out;
}

function cleanTitle(rawTitle: string, brewery: string): string {
  const title = stripOutOfStockMarkers(rawTitle).replace(PACKAGING_SUFFIX_RE, '').trim();
  const colon = title.indexOf(':');
  if (colon < 0) return title;

  const prefix = title.slice(0, colon).trim();
  const rest = title.slice(colon + 1).trim();
  const normalizedPrefix = normalize(prefix);
  const normalizedBrand = normalize(brandName(brewery));

  if (normalizedPrefix === normalizedBrand) return rest || title;
  if (normalizedPrefix.startsWith(`${normalizedBrand} `)) {
    const collaborator = prefix.slice(brandName(brewery).length).trim();
    return `${collaborator}: ${rest}`.trim();
  }

  return rest || title;
}

function splitVisibleTitle(rawTitle: string): { brewery: string; name: string } {
  const title = stripOutOfStockMarkers(rawTitle).replace(PACKAGING_SUFFIX_RE, '').trim();
  const colon = title.indexOf(':');
  if (colon < 0) return { brewery: '', name: title };
  const brewery = cleanBrewery(title.slice(0, colon));
  return { brewery, name: cleanTitle(title, brewery) };
}

function isBeerMeta(meta: ItemMeta | undefined): boolean {
  if (!meta) return true;
  const categories = [meta.item_category, meta.item_category2].filter(Boolean).map((c) => normalize(c!));
  return categories.some((c) => c.includes('piwo') || c.includes('napoje'));
}

function isNonBeerCard(title: string, meta: ItemMeta | undefined): boolean {
  if (!isBeerMeta(meta)) return true;
  return isNonBeerName(title) || NON_BEER_TITLE_RE.test(title);
}

export const piwnemosty: SiteAdapter = {
  id: 'piwnemosty',
  hostMatch: (url) => url.hostname === 'piwnemosty.pl' || url.hostname.endsWith('.piwnemosty.pl'),
  reRenderContainerSelector: '#search.products',
  isNonBeerPage: (url) => NON_BEER_PAGE_RE.test(url.pathname),

  parseCards(root) {
    const meta = itemMetadata(root);
    const cards: Card[] = [];

    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const id = el.getAttribute('data-product_id') ?? '';
      const item = meta.get(id);
      const rawTitle = item?.item_name?.trim() || text(el.querySelector('.product__name'));
      const title = stripOutOfStockMarkers(rawTitle);
      if (!title || isNonBeerCard(title, item)) continue;

      const visible = splitVisibleTitle(title);
      const brewery = cleanBrewery(item?.item_brand) || visible.brewery;
      const name = cleanTitle(title, brewery);
      if (!name) continue;

      cards.push({ el, brewery, name });
    }

    return cards;
  },
};
