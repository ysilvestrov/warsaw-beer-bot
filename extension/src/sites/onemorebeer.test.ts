import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { onemorebeer } from './onemorebeer';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/onemorebeer.html'), 'utf8');

let cards: ReturnType<typeof onemorebeer.parseCards>;
beforeAll(() => {
  cards = onemorebeer.parseCards(new DOMParser().parseFromString(html, 'text/html'));
});

function tile(brewery: string, title: string): string {
  return `
    <div class="one-product-list-view__tile">
      <div data-information-type="brand-name">
        <span class="one-product-tile-information__row__value">${brewery}</span>
      </div>
      <a class="product__title">${title}</a>
    </div>`;
}

describe('onemorebeer non-beer filtering', () => {
  it('drops accessory/merch tiles (glass, mug, shirt, book)', () => {
    const html = `<div class="one-catalog-view-list">
      ${tile('Schneider', 'SCHNEIDER WEISSE SZKLANKA 0,5 L')}
      ${tile('Inne', 'BALTIC PORTER DAY 2025 POKAL 0,33 L (gazetka)')}
      ${tile('Pinta', 'BALTIC PORTER DAY KOSZULKA BIAŁA XXL')}
      ${tile('Pinta', 'KSIĄŻKA POLSKIE I WYJĄTKOWE. PIWO GRODZISKIE')}
      ${tile('Schneider', 'SCHNEIDER WEISSE KUFEL CERAMIKA WYSOKI 0,5 L')}
    </div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(onemorebeer.parseCards(doc)).toEqual([]);
  });

  it('keeps a real beer that lives among accessories (MAGIC ROAD, can + deposit)', () => {
    const html = `<div class="one-catalog-view-list">
      ${tile('Magic Road', 'MAGIC ROAD YES CANNONS SLOW MARKET PUSZKA 0,5 L KAUCJA')}
    </div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = onemorebeer.parseCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].brewery).toBe('Magic Road');
  });

  it('filters delicatessen soft drinks per card while keeping eligible kvass', () => {
    const html = `<div class="one-catalog-view-list">
      ${tile('Kofola', 'KOFOLA ORYGINAL PUSZKA 0,5 L')}
      ${tile('Vigo Kombucha', 'VIGO KOMBUCHA MANGO BUT. 0,33 L')}
      ${tile('Vita Aloe', 'VITA ALOE ORIGINAL BUT. 0,5 L')}
      ${tile('Koreb', 'KOREB KWAS CHLEBOWY BUT. 0,5 L')}
    </div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = onemorebeer.parseCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].brewery).toBe('Koreb');
    expect(cards[0].name).toBe('KWAS CHLEBOWY');
  });

  it('does not filter by bare kombucha without the observed soft-drink brand', () => {
    const html = `<div class="one-catalog-view-list">
      ${tile('Funky Fluid', 'FUNKY FLUID KOMBUCHA SOUR BUT. 0,5 L')}
    </div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = onemorebeer.parseCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].brewery).toBe('Funky Fluid');
    expect(cards[0].name).toBe('KOMBUCHA SOUR');
  });
});

describe('onemorebeer adapter', () => {
  it('parses the rendered tiles', () => {
    expect(cards.length).toBeGreaterThanOrEqual(7);
  });

  it('extracts a non-empty brewery per tile (brand-name selector quirk)', () => {
    for (const c of cards) {
      expect(c.brewery.length).toBeGreaterThan(0);
    }
  });

  it('keeps the degree-ABV token and packaging tail out of the name', () => {
    for (const c of cards) {
      expect(c.name).not.toMatch(/°/);
      expect(c.name).not.toMatch(/\b(BUT|PUSZ)\b/i);
    }
  });

  it('never sets abv (the degree token is Plato/extract, not ABV)', () => {
    for (const c of cards) {
      expect(c.abv).toBeUndefined();
    }
  });

  it('defines waitForGrid (SPA grid paints client-side)', () => {
    expect(typeof onemorebeer.waitForGrid).toBe('function');
  });
});
