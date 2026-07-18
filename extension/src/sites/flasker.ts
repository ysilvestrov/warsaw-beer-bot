import type { Card, SiteAdapter } from './types';
import { waitForSelector } from '../content/grid-ready';
import { isNonBeerName } from './non-beer';
import { FLASKER_BREWERIES, type FlaskerBrewery } from './flasker-breweries.generated';

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

export interface FlaskerEvidence {
  productTags?: string[];
  productUrl?: string;
}

interface BreweryRule {
  canonical: string;
  tags: string[];
  slugPrefixes: string[];
  familySlugPrefixes?: string[];
  titleAliases: string[];
}

const BREWERY_RULES: BreweryRule[] = [
  {
    canonical: 'VibrantPour',
    tags: ['vibrant pour'],
    slugPrefixes: ['vibrant-pour-', 'vibrantpour-'],
    titleAliases: ['Vibrant Pour', 'VibrantPour'],
  },
  {
    canonical: 'Mad Brew',
    tags: ['mad brew'],
    slugPrefixes: ['mad-brew-', 'mad-'],
    familySlugPrefixes: [
      'lost-philosopher-',
      'the-lost-philosopher-',
      'de-zwarte-regel-',
      'предреліз-de-zwarte-regel-',
    ],
    titleAliases: ['Mad Brew'],
  },
  {
    canonical: 'Copper Head. Beer Workshop',
    tags: ['copper head'],
    slugPrefixes: ['copper-head-'],
    titleAliases: ['Copper Head'],
  },
  {
    canonical: 'Flasker',
    tags: ['flasker'],
    slugPrefixes: ['flasker-'],
    titleAliases: ['Flasker'],
  },
  {
    canonical: 'Hoppy Hog Family Brewery',
    tags: ['hoppy hog'],
    slugPrefixes: ['hoppy-hog-'],
    titleAliases: ['Hoppy Hog'],
  },
];

function normalizeTag(tag: string): string {
  return tag.replace(/\s+/g, ' ').trim().toLowerCase();
}

function productSlug(productUrl: string | undefined): string | null {
  if (!productUrl) return null;
  try {
    const url = new URL(productUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'flasker.com.ua' && !hostname.endsWith('.flasker.com.ua')) return null;
    const match = url.pathname.match(/\/product\/([^/]+)\/?$/u);
    if (!match) return null;
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }
}

function uniqueRule(rules: BreweryRule[]): BreweryRule | null {
  const unique = [...new Set(rules)];
  return unique.length === 1 ? unique[0] : null;
}

function resolveBreweryRule(evidence: FlaskerEvidence): BreweryRule | null {
  const slug = productSlug(evidence.productUrl);
  if (slug) {
    const familyRules = BREWERY_RULES.filter((rule) =>
      rule.familySlugPrefixes?.some((prefix) => slug.startsWith(prefix)),
    );
    if (familyRules.length > 0) return uniqueRule(familyRules);
  }

  const tags = new Set((evidence.productTags ?? []).map(normalizeTag));
  const tagRules = BREWERY_RULES.filter((rule) => rule.tags.some((tag) => tags.has(tag)));
  if (tagRules.length > 0) return uniqueRule(tagRules);

  if (!slug) return null;
  return uniqueRule(BREWERY_RULES.filter((rule) => rule.slugPrefixes.some((prefix) => slug.startsWith(prefix))));
}

function stripTitleAlias(head: string, aliases: string[]): string {
  const ordered = [...aliases].sort((a, b) => b.length - a.length);
  const lowerHead = head.toLowerCase();
  for (const alias of ordered) {
    const lowerAlias = alias.toLowerCase();
    if (lowerHead === lowerAlias) return head;
    if (!lowerHead.startsWith(lowerAlias)) continue;
    const rest = head.slice(alias.length);
    if (!/^[\s:–—-]/u.test(rest)) continue;
    const stripped = rest.replace(/^[\s:–—-]+/u, '').trim();
    return stripped || head;
  }
  return head;
}

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

// Registry path: resolve a brewery from the product's own tags. Returns null when
// no tag is a known registry brewery, or when two *different* breweries tie
// (ambiguous collab) — the caller then falls through to title-head / fallback.
export function breweryFromRegistryTags(tags: string[]): FlaskerBrewery | null {
  const set = new Set(tags.map(normalizeTag));
  const hits = FLASKER_BREWERIES.filter((b) => b.match.some((m) => set.has(m.toLowerCase())));
  return hits.length === 1 ? hits[0] : null;
}

// Registry path: resolve a brewery that appears as the leading prefix of the title
// head. Longest match wins (so "Хмільний кіт" beats a bare "Хмільний"). Requires a
// word boundary (exact head or `<brewery> `) so "DUMArine" never matches "DUMA".
export function breweryFromRegistryHead(
  head: string,
): { brewery: FlaskerBrewery; matched: string } | null {
  const lower = head.toLowerCase();
  let best: { brewery: FlaskerBrewery; matched: string } | null = null;
  for (const brewery of FLASKER_BREWERIES) {
    for (const m of brewery.match) {
      const lm = m.toLowerCase();
      if (lower === lm || lower.startsWith(`${lm} `)) {
        if (!best || m.length > best.matched.length) best = { brewery, matched: m };
      }
    }
  }
  return best;
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
export function parseTitle(
  rawTitle: string,
  evidence: FlaskerEvidence = {},
): { brewery: string; name: string; abv?: number } | null {
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

  const rule = resolveBreweryRule(evidence);
  const regTag = rule ? null : breweryFromRegistryTags(evidence.productTags ?? []);
  const regHead = rule || regTag ? null : breweryFromRegistryHead(head);

  let brewery: string;
  let nameBeforeCleanup: string;
  if (rule) {
    brewery = rule.canonical;
    nameBeforeCleanup = stripTitleAlias(head, rule.titleAliases);
  } else if (regTag) {
    brewery = regTag.canonical;
    nameBeforeCleanup = stripTitleAlias(head, regTag.match);
  } else if (regHead) {
    brewery = regHead.brewery.canonical;
    nameBeforeCleanup = stripTitleAlias(head, regHead.brewery.match);
  } else {
    const fallback = splitBreweryName(head);
    brewery = fallback.brewery;
    nameBeforeCleanup = fallback.name;
  }
  const name = stripMerchandisingPrefix(nameBeforeCleanup);
  return abv == null || !Number.isFinite(abv) ? { brewery, name } : { brewery, name, abv };
}

// --- view extractors -----------------------------------------------------
const ARCHIVE_CARD = 'li.product';                               // SSR loop: /1-2/, /product-category, /product-tag
const ARCHIVE_TITLE = 'h2.woocommerce-loop-product__title';
const TABLE_ROW = 'tr[data-title]';                              // Barn2 product table: /таблиця-товару/
const BLOCK_CARD = 'li.wc-block-grid__product';                  // "All Products" block: home/store (client-rendered)
const BLOCK_TITLE = '.wc-block-grid__product-title';
const GRID_SELECTOR = `${ARCHIVE_CARD}, ${TABLE_ROW}, ${BLOCK_CARD}`;

interface RawEntry {
  el: HTMLElement;
  title: string;
  categoryHint?: string;
  productTags: string[];
  productUrl?: string;
}

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function productUrl(raw: string | null, el: Element): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, el.ownerDocument.baseURI).href;
  } catch {
    return raw;
  }
}

function href(el: Element | null | undefined): string | undefined {
  return el ? productUrl(el.getAttribute('href'), el) : undefined;
}

function parseTableTags(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((part) => part.replace(/^\s*\d+:/u, '').trim())
    .filter(Boolean);
}

function archiveEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ARCHIVE_CARD))
    .map((el) => ({
      el,
      title: text(el.querySelector(ARCHIVE_TITLE)),
      productTags: Array.from(el.querySelectorAll('.mb-thumb-tag')).map((tag) => text(tag)),
      productUrl: href(el.querySelector('.woocommerce-LoopProduct-link[href]')),
    }));
}

function blockEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCK_CARD))
    .map((el) => ({
      el,
      title: text(el.querySelector(BLOCK_TITLE)),
      productTags: [],
      productUrl: href(el.querySelector('.wc-block-grid__product-title a[href]')),
    }));
}

function tableEntries(root: ParentNode): RawEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABLE_ROW)).map((el) => ({
    el,
    title: (el.getAttribute('data-title') ?? '').replace(/\s+/g, ' ').trim(),
    categoryHint: el.getAttribute('data-product_cat') ?? undefined,
    productTags: parseTableTags(el.getAttribute('data-product_tag')),
    productUrl: productUrl(el.getAttribute('data-href'), el),
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
      const parsed = parseTitle(e.title, {
        productTags: e.productTags,
        productUrl: e.productUrl,
      });
      if (!parsed) continue;
      cards.push({ el: e.el, ...parsed });
    }
    return cards;
  },
};
