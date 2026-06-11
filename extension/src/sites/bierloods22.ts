import type { Card, SiteAdapter } from './types';

const CARD_SELECTOR = '.product-block';

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

// bierloods22 cards expose the visible title (a.title text) as "{brewery} - {beer}" and
// the brand-prefixed form "{brand} {title}" as the a.title `title=` attribute. The brand
// tells us how many leading " - " segments are the brewery (handles breweries that
// themselves contain " - ", e.g. "Kykao - Handcrafted"). Empty/mismatched brand → split
// on the first " - " (previous behaviour).
function splitTitle(titleText: string, titleAttr: string): { brewery: string; name: string } | null {
  const title = titleText.trim();
  if (!title) return null;

  const segs = title.split(' - ');
  let brewerySegs = 1;
  const attr = titleAttr.trim();
  if (attr.length > title.length && attr.toLowerCase().endsWith(title.toLowerCase())) {
    const brand = attr.slice(0, attr.length - title.length).trim();
    if (brand) brewerySegs = brand.split(' - ').length;
  }

  if (segs.length <= brewerySegs) {
    // No separable name (no dash, or brand spans the whole title) → whole title as name.
    return { brewery: '', name: title };
  }
  const name = segs.slice(brewerySegs).join(' - ').trim();
  if (!name) return { brewery: '', name: title };
  return { brewery: segs.slice(0, brewerySegs).join(' - ').trim(), name };
}

export const bierloods22: SiteAdapter = {
  id: 'bierloods22',
  hostMatch: (url) => url.hostname === 'bierloods22.nl' || url.hostname.endsWith('.bierloods22.nl'),
  reRenderContainerSelector: '#collection-container',

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const a = el.querySelector('a.title');
      const parsed = splitTitle(text(a), a?.getAttribute('title') ?? '');
      if (!parsed) continue;
      cards.push({ el, brewery: parsed.brewery, name: parsed.name });
    }
    return cards;
  },
};
