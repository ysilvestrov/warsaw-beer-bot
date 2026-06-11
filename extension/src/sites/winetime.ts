import type { Card, SiteAdapter } from './types';

const CARD_SELECTOR = 'a.product-micro';
const CONTAINER_SELECTOR = '.products-column';
const DESCRIPTOR_RE =
  /\s+(?:світле|темне|напівтемне|нефільтроване|фільтроване|пастеризоване|безалкогольне)$/iu;

interface ProductMeta {
  id: number;
  title: string;
  manufacturer?: {
    title?: string | null;
  } | null;
}

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function ownerDocument(root: ParentNode): Document | null {
  return root instanceof Document ? root : root.ownerDocument;
}

function categoryJson(source: string): string | null {
  const marker = 'window.initialData.category =';
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) return null;

  const start = source.indexOf('{', markerAt + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

function productMeta(root: ParentNode): Map<number, ProductMeta> {
  const doc = ownerDocument(root);
  if (!doc) return new Map();

  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const json = categoryJson(script.textContent ?? '');
    if (!json) continue;

    try {
      const category = JSON.parse(json) as { products?: ProductMeta[] };
      return new Map((category.products ?? []).map((product) => [product.id, product]));
    } catch {
      return new Map();
    }
  }

  return new Map();
}

function stripPrefix(value: string, prefix: string): string {
  const trimmed = value.trim();
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) return trimmed;
  if (trimmed.toLocaleLowerCase('uk-UA').startsWith(normalizedPrefix.toLocaleLowerCase('uk-UA'))) {
    return trimmed.slice(normalizedPrefix.length).trim();
  }
  return trimmed;
}

function stripSuffix(value: string, suffix: string): string {
  const trimmed = value.trim();
  const normalizedSuffix = suffix.trim();
  if (!normalizedSuffix) return trimmed;
  const lower = trimmed.toLocaleLowerCase('uk-UA');
  const suffixLower = normalizedSuffix.toLocaleLowerCase('uk-UA');
  if (lower === suffixLower || lower.endsWith(` ${suffixLower}`)) {
    const next = trimmed.slice(0, -normalizedSuffix.length).trim();
    if (next) return next;
  }
  return trimmed;
}

function breweryPrefixes(brewery: string): string[] {
  const base = brewery.trim();
  const withoutBrewerySuffix = base.replace(/\s+(?:brewery|броварня)$/iu, '').trim();
  return [base, withoutBrewerySuffix].filter((value, index, values) => value && values.indexOf(value) === index);
}

function cleanName(rawTitle: string, brewery: string): string {
  const original = rawTitle.replace(/\s+/g, ' ').trim();
  let name = stripPrefix(original, 'Пиво');

  for (const prefix of breweryPrefixes(brewery)) {
    name = stripPrefix(name, prefix);
  }

  let cleaned = name.replace(/\s+(?:\d+(?:[,.]\d+)?\s*(?:л|l|ml|мл))$/iu, '').trim();
  while (DESCRIPTOR_RE.test(cleaned)) cleaned = cleaned.replace(DESCRIPTOR_RE, '').trim();
  for (const suffix of breweryPrefixes(brewery)) {
    cleaned = stripSuffix(cleaned, suffix);
  }

  return cleaned || name || original;
}

function visibleBrewery(el: Element): string {
  const rows = Array.from(el.querySelectorAll('.j-grow-1-xs.j-size-0\\.75-xs'));
  return text(rows[rows.length - 1]);
}

export const winetime: SiteAdapter = {
  id: 'winetime',
  hostMatch: (url) => url.hostname === 'winetime.com.ua' || url.hostname.endsWith('.winetime.com.ua'),
  reRenderContainerSelector: CONTAINER_SELECTOR,

  parseCards(root) {
    const meta = productMeta(root);
    const cards: Card[] = [];

    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const id = Number(el.querySelector<HTMLElement>('[data-productkey]')?.dataset.productkey);
      const product = Number.isFinite(id) ? meta.get(id) : undefined;
      const rawTitle = product?.title ?? text(el.querySelector('.product-micro--title'));
      if (!rawTitle) continue;

      const brewery = product?.manufacturer?.title?.trim() || visibleBrewery(el);
      const name = cleanName(rawTitle, brewery);
      if (!name) continue;

      cards.push({ el, brewery, name });
    }

    return cards;
  },
};
