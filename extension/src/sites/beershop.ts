import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

const BASE_HOSTS = ['beershop.pl', 'beershop.cz', 'beershop.sk', 'beershop.eu', 'beershop.de'] as const;
const CARD_SELECTOR = 'article.card-item[data-product-id]';
const NON_BEER_CATEGORY_IDS = new Set(['132', '134', '135', '150', '151', '152', '153', '154', '155', '220', '258', '263', '267', '268', '275']);

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

function baseHost(hostname: string): (typeof BASE_HOSTS)[number] | undefined {
  const normalized = hostname.toLowerCase();
  return BASE_HOSTS.find((host) => normalized === host || normalized.endsWith(`.${host}`));
}

function pageCategoryId(root: ParentNode): string | undefined {
  const metadataRoot = root instanceof Document ? root : (root as Node).ownerDocument ?? root;
  for (const script of Array.from(metadataRoot.querySelectorAll('script'))) {
    const match = script.textContent?.match(/"category"\s*:\s*\{\s*"id"\s*:\s*"(\d+)"/);
    if (match) return match[1];
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
    return NON_BEER_PATHS[host].has(pathname);
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
      const name = brewery && title.startsWith(brewery) ? title.slice(brewery.length).trim() : title;
      if (!name || isNonBeerName(`${brewery} ${name}`)) continue;
      cards.push({ el, brewery, name });
    }
    return cards;
  },
};
