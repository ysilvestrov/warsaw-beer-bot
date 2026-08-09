import type { Card, SiteAdapter } from './types';
import { waitForSelector } from '../content/grid-ready';
import { isNonBeerName, isNonAlcoholicSoftDrinkFamily } from './non-beer';
import { usableAbv } from '../shared/abv';

const CARD_SELECTOR = '.one-product-list-view__tile';
const BREWERY_SELECTOR = '[data-information-type="brand-name"] .one-product-tile-information__row__value';
const TITLE_SELECTOR = 'a.product__title';
// .one-product-list-view appears once per tile; .one-catalog-view-list is the single top-level
// catalog component container (count: 1) that wraps all tiles — use that for the re-render observer.
const CONTAINER_SELECTOR = '.one-catalog-view-list';
// #369: the "Dane techniczne" panel is a hidden SIBLING of the tile, not a child —
// both live under this per-product wrapper.
const WRAPPER_SELECTOR = '.one-product-list-view';
const TECH_PANEL_SELECTOR = '.one-product-technical-data';

// onemorebeer-local merch tokens (Polish): glassware, mugs, apparel, books on the accessories page.
// Stems handle inflection (szklanka/szklanki, koszulka/koszulkę). Deliberately excludes "puszka"
// (can) and "kaucja" (deposit) — those mark a real beer (e.g. MAGIC ROAD … PUSZKA … KAUCJA).
const MERCH_RE = /\b(?:szklank|pokal|kufel|koszulk|ksi[ąa]żk|ksiazk|akcesori|otwieracz|podstawk|podkładk)\w*/i;
const SOFT_DRINK_RE = /\b(?:kofola|vigo kombucha|vita aloe)\b/i;

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

// The "NN,N°" token in titles is degrees Plato (extract), not ABV — used only to trim the name, never sent as abv.
function cleanName(rawTitle: string, brewery: string): string {
  let name = rawTitle;
  const b = brewery.trim();
  if (b && name.toLowerCase().startsWith(b.toLowerCase())) name = name.slice(b.length);
  // strip the degree-extract (Plato) token and everything after it ("15,0° BUT. 0,5 L").
  // Assumes ° never appears inside a beer name on this site — true for all observed titles.
  name = name.replace(/\s*\d+(?:[.,]\d+)?\s*°.*$/, '');
  // strip a trailing packaging tail when there was no degree token ("… BUT. 0,33 L")
  name = name.replace(/\s*(BUT|PUSZ|KEG|ZGRZ)\w*\.?\s*\d+(?:[.,]\d+)?\s*l\b.*$/i, '');
  return name.trim();
}

// "4.5%", " 0.0%", "4,8 %" → number. Anything else ("n/d", "-", "", "9999%") → undefined.
// 0 is a legitimate result and must never be conflated with "missing": AleBrowar's
// Kwas Chlebowy Bright (0.0%) is told apart from Light (0.5%) by nothing else (#322).
// Bounds come from usableAbv so a Card never carries an impossible ABV in the first
// place; usableAbv is applied again at the payload boundary for the other adapters.
function parseAbv(value: string): number | undefined {
  const m = value.replace(',', '.').match(/^\s*(\d+(?:\.\d+)?)\s*%?\s*$/);
  if (!m) return undefined;
  return usableAbv(Number(m[1]));
}

// #369: the shop publishes ABV and style in a "Dane techniczne" accordion that is
// already in the DOM but collapsed (aria-expanded="false", display:none), so neither
// a detail fetch nor a synthetic click is needed. Deliberately no fallback selector:
// if this structure changes the adapter tests should fail loudly, not degrade quietly.
function technicalFacts(tile: HTMLElement): { abv?: number; style?: string } {
  const panel = tile.closest(WRAPPER_SELECTOR)?.querySelector(TECH_PANEL_SELECTOR);
  if (!panel) return {};
  const facts: { abv?: number; style?: string } = {};
  for (const row of Array.from(panel.children)) {
    const spans = row.querySelectorAll('span');
    const label = text(spans[0]);
    const value = text(spans[1]);
    if (label.startsWith('Moc')) {
      const abv = parseAbv(value);
      if (abv !== undefined) facts.abv = abv;
    } else if (label === 'Styl' && value) {
      facts.style = value;
    }
  }
  return facts;
}

export const onemorebeer: SiteAdapter = {
  id: 'onemorebeer',
  hostMatch: (url) => url.hostname === 'onemorebeer.pl' || url.hostname.endsWith('.onemorebeer.pl'),
  reRenderContainerSelector: CONTAINER_SELECTOR,

  async waitForGrid(root) {
    await waitForSelector(root, CARD_SELECTOR, { timeoutMs: 8000 });
  },

  parseCards(root) {
    const cards: Card[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      const brewery = text(el.querySelector(BREWERY_SELECTOR));
      const rawTitle = text(el.querySelector(TITLE_SELECTOR));
      if (!brewery || !rawTitle) continue;
      if (isNonBeerName(rawTitle) || MERCH_RE.test(rawTitle) || SOFT_DRINK_RE.test(rawTitle)) continue;
      const name = cleanName(rawTitle, brewery);
      if (!name) continue;
      const facts = technicalFacts(el);
      if (isNonAlcoholicSoftDrinkFamily({ name, style: facts.style, abv: facts.abv })) continue;
      cards.push({ el, brewery, name, ...facts });
    }
    return cards;
  },
};
