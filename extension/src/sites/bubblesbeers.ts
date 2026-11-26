import type { Card, SiteAdapter } from './types';
import { isNonBeerName } from './non-beer';

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/**
 * Brand-level tokens for non-beer products sold on Bubbles Beers.
 * Checked strictly against the first segment (brand) of the title to avoid false
 * positives on real beers containing flavor or series names like "Tangerine",
 * "Wolf Pack", "Cream Soda Sour", "Cola de Caballo", "Copa del Rey", or "Taller".
 * Note: the global isNonBeerName() helper checks universal non-beer multi-word phrases
 * across the full title, while ES_NON_BEER_BRAND_RE checks only the initial brand segment.
 */
const ES_NON_BEER_BRAND_RE =
  /^(?:caja\s+sorpresa|pack\b|club\s+cervecero|bubbles\s+beer\s+club|luno\s+soda|tarjeta\s+de\s+regalo|abridor|vaso|camiseta|gorra|cata\b)/i;

const NON_BEER_PAGE_RE =
  /\/(?:catas-de-cerveza|blog-de-cerveza|distribucion|contacto|aviso-legal|politica-de-privacidad|carrito|finalizar-compra|mi-cuenta(?:-\d+)?|my-account)(?:[/?#]|$)/i;

const CANONICAL_BREWERIES: Readonly<Record<string, string>> = {
  althaia: 'Cervezas Althaia',
  attik: 'Attik Brewing',
  garage: 'Garage Beer Co.',
  'garage beer': 'Garage Beer Co.',
  'garage beer co': 'Garage Beer Co.',
  'garage beer co.': 'Garage Beer Co.',
  'la quince': 'La Quince Brewing Co.',
  laquince: 'La Quince Brewing Co.',
  'la sitgetana': 'La Sitgetana Craftbeer',
  montseny: 'Companyia Cervesera del Montseny',
  'octavo arte': 'Octavo Arte',
  oddity: 'Oddity Brewing',
  'oso brew': 'Oso Brew Co',
  'oso brew co': 'Oso Brew Co',
  'oso brew co.': 'Oso Brew Co',
  'rio azul': 'RIOAZUL',
  'río azul': 'RIOAZUL',
  'saez&son': 'Sáez & Son',
  'sáez&son': 'Sáez & Son',
  'saez & son': 'Sáez & Son',
  'sáez & son': 'Sáez & Son',
  'saez and son': 'Sáez & Son',
  'sáez and son': 'Sáez & Son',
  yakka: 'Cervezas Yakka',
};

const SLUG_OVERRIDES: Readonly<Record<string, { brewery?: string; name?: string; skip?: boolean }>> = {
  // Untappd bid 7401043
  'rio-azul-x-laquince-a-giant-leap-for-an-ape-tiramisu-patry-stout': {
    brewery: 'La Quince Brewing Co.',
    name: 'A GIANT LEAP FOR AN APE!',
  },
  // Untappd bid 7180590
  'saez-son-saezsonf-fresh-press-te-rp-smoothiesour': {
    brewery: 'Sáez & Son',
    name: 'TERP Fresh Press',
  },
  // Untappd bid 7180377
  'saez-son-golden-hour-terp-smoothie-sour': {
    brewery: 'Sáez & Son',
    name: 'TERP Golden Hour',
  },
  // Untappd bid 6833796
  'saezson-felippa-west-coast-ipa': {
    brewery: 'FELIPPA BREW CO by Sáez & Son',
    name: 'FELIPPA',
  },
  // Untappd bid 6147841
  'oddity-wildfires': {
    brewery: 'Oddity Brewing',
    name: 'Wildfires',
  },
  // Untappd bid 5292594: Oso Brew Co — Mesa (Table Beer).
  // Missing from server catalog; fuzzy search on "Mesa" incorrectly matches "Ménage À Trois" (bid 5019595).
  // Skipped deliberately to avoid showing a false positive badge.
  'oso-brew-co-mesa-table-beer': {
    skip: true,
  },
};

const KNOWN_BREWERIES = [
  'Companyia Cervesera del Montseny',
  'La Quince Brewing Co.',
  'La Sitgetana Craftbeer',
  'FELIPPA BREW CO by Sáez & Son',
  'Garage Beer Co.',
  'Garage Beer Co',
  'Garage Beer',
  'Oso Brew Co.',
  'Oso Brew Co',
  'Oso Brew',
  'Sáez & Son',
  'Saez & Son',
  'Sáez and Son',
  'Saez and Son',
  'Sáez&Son',
  'Saez&Son',
  'La Quince',
  'La Sitgetana',
  'Octavo Arte',
  'Río Azul',
  'Rio Azul',
  'Althaia',
  'Attik',
  'Garage',
  'Montseny',
  'Oddity',
  'Yakka',
];

function canonicalBrewery(rawBrewery: string): string {
  const trimmed = rawBrewery.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const direct = CANONICAL_BREWERIES[trimmed.toLowerCase()];
  if (direct) return direct;

  const collabParts = trimmed.split(/\s+x\s+/i);
  if (collabParts.length > 1) {
    const primary = collabParts[0].trim();
    return CANONICAL_BREWERIES[primary.toLowerCase()] ?? primary;
  }

  return trimmed;
}

/**
 * Bubbles Beers is a Spanish store; browser auto-translation may translate
 * the visible `.woocommerce-loop-product__title`. For simple in-stock products,
 * the button `.add_to_cart_button[data-success_message]` carries the untranslated
 * Spanish title inside «...». Variable or out-of-stock products lack this attribute,
 * so they fall back to the visible heading text.
 */
function extractOriginalTitle(el: HTMLElement): string {
  const msg = el.querySelector<HTMLElement>('.add_to_cart_button')?.getAttribute('data-success_message')?.trim() ?? '';
  const quoted = msg.match(/«([^»]+)»/);
  if (quoted && quoted[1].trim()) {
    return quoted[1].replace(/\s+/g, ' ').trim();
  }
  return text(el.querySelector<HTMLElement>('.woocommerce-loop-product__title'));
}

function productSlug(el: HTMLElement): string {
  const href = el.querySelector<HTMLAnchorElement>('a[href*="/product/"]')?.getAttribute('href') ?? '';
  const match = href.match(/\/product\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : '';
}

function stripVolume(text: string): string {
  return text.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:cl|ml|l)\s*$/i, '').trim();
}

function cleanBeerName(rawTitle: string, brewery: string): string {
  let name = rawTitle.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[-–—:\s]+/, '').trim();
  const b = brewery.trim();
  if (b && name.toLowerCase().startsWith(b.toLowerCase())) {
    const rest = name.slice(b.length);
    if (!rest || /^[\s\-–—:]/.test(rest)) {
      const stripped = rest.replace(/^[-–—:\s]+/, '').trim();
      if (stripped) {
        name = stripped;
      }
    }
  }
  return stripVolume(name);
}

function parseTitleParts(rawTitle: string): { brewery: string; name: string; style?: string } {
  const trimmed = rawTitle.replace(/\s+/g, ' ').trim();
  const parts = trimmed
    .split(/\s*(?:[\u2013\u2014]|\s+-\s*|\s*-\s+)\s*/)
    .map((p) => p.trim());

  if (parts.length >= 3) {
    const rawBrewery = parts[0];
    const rawName = parts[1];
    if (!rawBrewery || !rawName) {
      return { brewery: '', name: '' };
    }
    const name = cleanBeerName(rawName, rawBrewery);
    if (!name) {
      return { brewery: '', name: '' };
    }
    const rawStyle = parts.slice(2).filter(Boolean).join(' – ');
    const style = stripVolume(rawStyle);
    return { brewery: canonicalBrewery(rawBrewery), name, ...(style ? { style } : {}) };
  }

  if (parts.length === 2) {
    const rawBrewery = parts[0];
    const rawName = parts[1];
    if (!rawBrewery || !rawName) {
      return { brewery: '', name: '' };
    }
    const name = cleanBeerName(rawName, rawBrewery);
    if (!name) {
      return { brewery: '', name: '' };
    }
    return { brewery: canonicalBrewery(rawBrewery), name };
  }

  // Fallback for single segment e.g. "Yakka Querida Ipa"
  for (const b of KNOWN_BREWERIES) {
    if (trimmed.toLowerCase().startsWith(b.toLowerCase())) {
      const rest = trimmed.slice(b.length);
      if (!rest || /^[\s\-–—:]/.test(rest)) {
        const namePart = rest.trim();
        const cleaned = cleanBeerName(namePart, b);
        if (cleaned) {
          return { brewery: canonicalBrewery(b), name: cleaned };
        }
        // Entire title matches a known brewery without a remaining beer name;
        // stop immediately rather than allowing a shorter prefix to turn brewery suffixes into a name.
        return { brewery: canonicalBrewery(b), name: '' };
      }
    }
  }

  return { brewery: '', name: cleanBeerName(trimmed, '') };
}

function hasNonBeerClass(el: HTMLElement): boolean {
  return (
    el.classList.contains('product_cat-packs') ||
    el.classList.contains('product_tag-soda') ||
    el.classList.contains('product_tag-caja-sorpresa') ||
    el.classList.contains('product_tag-pack-cervezas') ||
    el.classList.contains('product_tag-pack-degustacion') ||
    el.classList.contains('product_cat-refrescos') ||
    el.classList.contains('product_tag-refrescos')
  );
}

export const bubblesbeers: SiteAdapter = {
  id: 'bubblesbeers',
  hostMatch: (url) => url.hostname === 'bubblesbeers.com' || url.hostname.endsWith('.bubblesbeers.com'),
  reRenderContainerSelector: 'ul.products',

  isNonBeerPage(url) {
    return NON_BEER_PAGE_RE.test(url.pathname);
  },

  parseCards(root) {
    const cards: Card[] = [];
    const items = Array.from(root.querySelectorAll<HTMLElement>('li.product'));

    for (const el of items) {
      const rawTitle = extractOriginalTitle(el);
      if (!rawTitle) continue;

      const firstSegment = rawTitle.split(/\s*(?:[\u2013\u2014]|\s+-\s*|\s*-\s+)\s*/)[0].trim();
      const catEl = el.querySelector<HTMLElement>('.ast-woo-product-category');
      const catText = text(catEl);

      const isNonBeer =
        isNonBeerName(rawTitle) ||
        ES_NON_BEER_BRAND_RE.test(firstSegment) ||
        catText === 'Packs' ||
        catText === 'Refrescos' ||
        hasNonBeerClass(el);

      if (isNonBeer) {
        cards.push({ el, brewery: '', name: '', nonBeer: true });
        continue;
      }

      const slug = productSlug(el);
      const override = slug ? SLUG_OVERRIDES[slug] : undefined;
      if (override?.skip) {
        cards.push({ el, brewery: '', name: rawTitle, skip: true, skipReason: 'unparsed' });
        continue;
      }
      const parsed = parseTitleParts(rawTitle);
      const brewery = override?.brewery ?? parsed.brewery;
      const name = override?.name ?? parsed.name;
      const effectiveStyle = parsed.style;

      if (!brewery || !name) {
        cards.push({ el, brewery: '', name: rawTitle, skip: true, skipReason: 'unparsed' });
        continue;
      }

      cards.push({
        el,
        brewery,
        name,
        ...(effectiveStyle ? { style: effectiveStyle } : {}),
      });
    }

    return cards;
  },
};
