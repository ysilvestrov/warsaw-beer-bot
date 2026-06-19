import type { Card, SiteAdapter } from './types';
import { waitForSelector } from '../content/grid-ready';
import { isNonBeerName } from './non-beer';

// --- volume / abv --------------------------------------------------------
// Beers always quote a volume; snacks/merch never do. Volume is both the primary
// non-beer gate and the marker for where the beer name ends.
const VOLUME_UNIT_RE = /\d+(?:[.,]\d+)?\s*(?:ml|мл|l|л)(?![\p{L}])/iu; // 330ml, 0.33л, 500 мл, 1l
const VOLUME_BARE_RE = /\b0[.,]\d+\b(?!\s*(?:кг|kg))/iu;              // bare litre decimal, not a weight (kg)
const ABV_RE = /(\d+(?:[.,]\d+)?)\s*%/u;

function firstIndex(s: string, re: RegExp): number {
  const m = s.match(re);
  return m && m.index != null ? m.index : -1;
}

function volumeIndex(title: string): number {
  const a = firstIndex(title, VOLUME_UNIT_RE);
  const b = firstIndex(title, VOLUME_BARE_RE);
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

// --- brewery / name ------------------------------------------------------
const PAREN_RE = /^\([^)]*\)$/u;
const TWO_WORD_BREWERIES = new Set(['vibrant pour']);

function splitBreweryName(head: string): { brewery: string; name: string } {
  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return { brewery: head, name: head };

  const firstTwo = `${tokens[0]} ${tokens[1]}`.toLowerCase();
  const takeTwo = TWO_WORD_BREWERIES.has(firstTwo) || PAREN_RE.test(tokens[1]);

  const breweryTokens = takeTwo ? tokens.slice(0, 2) : tokens.slice(0, 1);
  const brewery = breweryTokens.join(' ');
  const name = tokens.slice(breweryTokens.length).join(' ').trim();
  return { brewery, name: name || brewery };
}

const MERCH_PREFIX_RE = /^(?:(?:ПРЕДРЕЛІЗ|ПРЕДРЕДІЗ)(?=$|[\s:–—-])|ПРОБНИК:)[\s:–—-]*/iu;

export function stripMerchandisingPrefix(name: string): string {
  const stripped = name.replace(MERCH_PREFIX_RE, '').trim();
  return stripped || name;
}

// --- non-beer gates ------------------------------------------------------
// Secondary gate: catches sets/glassware/snacks/vouchers that DO quote a volume
// (the volume gate alone would let them through — e.g. a multi-beer set or a sauce
// listed with a bottle size). Short ambiguous English words are bounded so they
// never fire inside a beer name (e.g. "Sunset"); the Cyrillic merch/snack stems are
// unambiguous. isNonBeerName supplies the shared multi-word phrases (gift set,
// "+ келих", набір, сертифікат, …).
const NONBEER_TITLE_RE = /(?:\bset\b|\bglass\b|\bmerch\b|\bsouvenir\b|\bgift\b|\bsnack\b|zestaw|сет|келих|склянк|відкривач|сувенір|мерч|соус|сало|гриб|шкварк|снек|закуск|подарунк)/iu;

// Category hint (Barn2 table data-product_cat). Category names are safe for
// broader snack/merch tokens since they are not beer names.
const NONBEER_CATEGORY_RE = /(?:снек|снэк|закуск|набор|набір|сет|\bset\b|аксесуар|мерч|merch|подарунк|snack|\bglass\b|\bgift\b)/iu;

export function isNonBeerTitle(title: string): boolean {
  return isNonBeerName(title) || NONBEER_TITLE_RE.test(title);
}

export function isNonBeerCategory(cat: string): boolean {
  return NONBEER_CATEGORY_RE.test(cat);
}

// Returns null when the title carries no volume token → treat as non-beer.
export function parseTitle(rawTitle: string): { brewery: string; name: string; abv?: number } | null {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const volAt = volumeIndex(title);
  if (volAt < 0) return null;                         // primary positive gate

  const abvMatch = title.match(ABV_RE);
  const abvAt = abvMatch?.index ?? -1;
  const headEnd = abvAt >= 0 ? Math.min(abvAt, volAt) : volAt;
  const head = title.slice(0, headEnd).trim();
  if (!head) return null;

  const abv = abvMatch ? Number(abvMatch[1].replace(',', '.')) : undefined;

  const { brewery, name } = splitBreweryName(head);
  return abv == null || !Number.isFinite(abv) ? { brewery, name } : { brewery, name, abv };
}

// --- view extractors -----------------------------------------------------
const ARCHIVE_CARD = 'li.product';                               // SSR loop: /1-2/, /product-category, /product-tag
const ARCHIVE_TITLE = 'h2.woocommerce-loop-product__title';
const TABLE_ROW = 'tr[data-title]';                              // Barn2 product table: /таблиця-товару/
const BLOCK_CARD = 'li.wc-block-grid__product';                  // "All Products" block: home/store (client-rendered)
const BLOCK_TITLE = '.wc-block-grid__product-title';
const GRID_SELECTOR = `${ARCHIVE_CARD}, ${TABLE_ROW}, ${BLOCK_CARD}`;

interface RawEntry { el: HTMLElement; title: string; categoryHint?: string }

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function archiveEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ARCHIVE_CARD))
    .map((el) => ({ el, title: text(el.querySelector(ARCHIVE_TITLE)) }));
}

function blockEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCK_CARD))
    .map((el) => ({ el, title: text(el.querySelector(BLOCK_TITLE)) }));
}

function tableEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABLE_ROW)).map((el) => ({
    el,
    title: (el.getAttribute('data-title') ?? '').replace(/\s+/g, ' ').trim(),
    categoryHint: el.getAttribute('data-product_cat') ?? undefined,
  }));
}

// --- adapter -------------------------------------------------------------
export const flasker: SiteAdapter = {
  id: 'flasker',
  hostMatch: (url) => url.hostname === 'flasker.com.ua' || url.hostname.endsWith('.flasker.com.ua'),

  async waitForGrid(root) {
    await waitForSelector(root, GRID_SELECTOR, { timeoutMs: 8000 });
  },

  parseCards(root) {
    const entries = [...archiveEntries(root), ...tableEntries(root), ...blockEntries(root)];
    const cards: Card[] = [];
    for (const e of entries) {
      if (!e.title) continue;
      if (isNonBeerTitle(e.title)) continue;
      if (e.categoryHint && isNonBeerCategory(e.categoryHint)) continue;
      const parsed = parseTitle(e.title);
      if (!parsed) continue;
      cards.push({ el: e.el, ...parsed });
    }
    return cards;
  },
};
