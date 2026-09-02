import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

const BASE_HOSTS = ['beershop.pl', 'beershop.cz', 'beershop.sk', 'beershop.eu', 'beershop.de'] as const;
const CARD_SELECTOR = 'article.card-item[data-product-id]';
const NON_BEER_CATEGORY_IDS = new Set(['132', '134', '135', '150', '151', '152', '153', '154', '155', '220', '258', '263', '267', '268', '275']);
// Only these known storefront/packaging suffixes may follow the title-derived name in a product slug.
const PRODUCT_SLUG_SUFFIXES = new Set(['pl', 'cz', 'sk', 'eu', 'de', 'can', 'bottle', 'plech', 'puszka', 'butelka']);

const NON_BEER_PATHS: Record<(typeof BASE_HOSTS)[number], ReadonlySet<string>> = {
  'beershop.pl': new Set([
    '/limonady-coly', '/limonady', '/limonady-1', '/coly', '/toniky',
    '/funkcni-napoje', '/kombuchy-a-shoty',
    '/darky-pro-pivare', '/darkove-poukazy', '/beershop-merch', '/otwieracze', '/darkova-baleni',
    '/delikatesy-k-pivu',
  ]),
  'beershop.cz': new Set([
    '/limonady-coly', '/limonady', '/limonady-1', '/coly', '/toniky',
    '/funkcni-napoje', '/kombuchy', '/giny-rumy',
    '/darky-pro-pivare', '/darkove-poukazy', '/beershop-merch', '/otviraky', '/darkova-baleni',
    '/delikatesy-k-pivu',
  ]),
  'beershop.sk': new Set([
    '/limonady-coly', '/limonady', '/coly', '/toniky',
    '/funkcne-napoje', '/kombuchy', '/giny-rumy',
    '/darceky-pre-pivarov', '/darcekove-poukazy', '/beershop-merch', '/otvarace', '/darcekove-balenia',
    '/delikatesy-k-pivu',
  ]),
  'beershop.eu': new Set([
    '/smart-drinks', '/kombuches-shots',
    '/gifts-for-brewerers', '/gift-vouchers', '/beershop-merch', '/openers', '/gift-packs',
  ]),
  'beershop.de': new Set([
    '/smart-drinks', '/kombuches-shots',
    '/gifts-for-brewerers', '/gift-vouchers', '/beershop-merch', '/openers', '/gift-packs',
  ]),
};

function text(el: Element | null): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function comparableToken(value: string): string {
  return value
    .replace(/&/g, 'and')
    .replace(/[Øø]/g, 'o')
    .replace(/[Łł]/g, 'l')
    .replace(/[Ææ]/g, 'ae')
    .replace(/[Œœ]/g, 'oe')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function productSlugTokens(header: Element | null): string[] {
  const href = header?.getAttribute('href');
  if (!href) return [];

  const match = href.match(/\/p\/([^/?#]+)/);
  if (!match) return [];

  try {
    return decodeURIComponent(match[1]).split('-').map(comparableToken).filter(Boolean);
  } catch {
    return [];
  }
}

function hasTerminalTokenSequence(values: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || sequence.length > values.length) return false;
  return values.some((_, start) => {
    const matches = sequence.every((token, offset) => values[start + offset] === token);
    const suffix = values.slice(start + sequence.length);
    return matches && suffix.every((token) => PRODUCT_SLUG_SUFFIXES.has(token));
  });
}

function beerNameFromTitle(name: string, header: Element | null): string {
  const withoutSeriesLabel = name.replace(/^of the Month\s+/i, '');
  const plato = withoutSeriesLabel.match(/^(\d+(?:[.,]\d+)?\s*°)\s*(.+)$/u);
  const prefix = plato?.[1] ?? '';
  const visibleName = plato?.[2] ?? withoutSeriesLabel;
  const visibleTokens = visibleName.split(/\s+/);
  const comparableVisibleTokens = visibleTokens
    .map((word, index) => ({ index, token: comparableToken(word) }))
    .filter(({ token }) => token);
  const slugTokens = productSlugTokens(header);

  for (let matchedLength = comparableVisibleTokens.length - 1; matchedLength > 0; matchedLength -= 1) {
    const titlePrefix = comparableVisibleTokens.slice(0, matchedLength);
    if (!hasTerminalTokenSequence(slugTokens, titlePrefix.map(({ token }) => token))) continue;

    const lastMatchedToken = titlePrefix[titlePrefix.length - 1];
    const matchedName = visibleTokens.slice(0, lastMatchedToken.index + 1).join(' ');
    return prefix ? `${prefix} ${matchedName}` : matchedName;
  }

  return withoutSeriesLabel;
}

function baseHost(hostname: string): (typeof BASE_HOSTS)[number] | undefined {
  const normalized = hostname.toLowerCase();
  return BASE_HOSTS.find((host) => normalized === host || normalized.endsWith(`.${host}`));
}

function pageCategoryId(root: ParentNode): string | undefined {
  const metadataRoot = root instanceof Document ? root : (root as Node).ownerDocument ?? root;
  for (const script of Array.from(metadataRoot.querySelectorAll('script'))) {
    const match = script.textContent?.match(/"category"\s*:\s*\{\s*"id"\s*:\s*(?:"(\d+)"|(\d+))/);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}

export const beershop: SiteAdapter = {
  id: 'beershop',
  hostMatch: (url) => baseHost(url.hostname) !== undefined,
  reRenderContainerSelector: '.p-l-boxes',
  isNonBeerPage(url) {
    const host = baseHost(url.hostname);
    if (!host) return false;
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const categoryPath = pathname.replace(/\/pg-\d+$/, '');
    return NON_BEER_PATHS[host].has(categoryPath);
  },

  parseCards(root) {
    const productEls = Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR));
    if (productEls.length === 0) return [];

    const categoryId = pageCategoryId(root);
    if (categoryId && NON_BEER_CATEGORY_IDS.has(categoryId)) return [];

    const cards: Card[] = [];
    for (const el of productEls) {
      const header = el.querySelector('.p-i-header a') ?? el.querySelector('.p-i-header');
      const brewery = text(header?.querySelector('strong') ?? null);
      const title = text(header);
      const titleName = brewery && title.startsWith(brewery) ? title.slice(brewery.length).trim() : title;
      const name = beerNameFromTitle(titleName, header);
      if (!name || isNonBeerName(`${brewery} ${name}`)) continue;
      cards.push({ el, brewery, name });
    }
    return cards;
  },
};
