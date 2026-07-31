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

  // #369: abv now comes from the technical panel's "Moc (%)" row. The degree token
  // in titles is Plato/extract and must still never be used as ABV — the four PINTA
  // products in the fixture carry a ° token and no Moc row, so they stay undefined.
  it('never derives abv from the degree token (Plato/extract, not ABV)', () => {
    const plato = cards.filter((c) => /^PINTA/i.test(c.brewery) || c.brewery === 'PINTA');
    expect(plato.length).toBeGreaterThan(0);
    for (const c of plato) {
      expect(c.abv).toBeUndefined();
    }
  });

  it('defines waitForGrid (SPA grid paints client-side)', () => {
    expect(typeof onemorebeer.waitForGrid).toBe('function');
  });
});

// #369: the shop publishes ABV and style in a "Dane techniczne" accordion that is
// already in the DOM but collapsed. The panel is NOT inside the tile — it is a hidden
// sibling under the shared .one-product-list-view wrapper.
function wrappedTile(brewery: string, title: string, rows: [string, string][]): string {
  const cells = rows
    .map(([k, v]) => `<div><span>${k}</span><span class="ml-1 font-weight-bold text-right"> ${v}</span></div>`)
    .join('');
  return `
    <div class="my-2 col-12 one-product-list-view">
      <div class="one-product-list-view__tile">
        <div data-information-type="brand-name">
          <span class="one-product-tile-information__row__value">${brewery}</span>
        </div>
        <a class="product__title">${title}</a>
      </div>
      <div class="border-top bg-white collapse" style="display:none;">
        <div class="row one-product-technical-data w-100 m-0 py-1 text">${cells}</div>
      </div>
    </div>`;
}

describe('onemorebeer technical panel (#369)', () => {
  it('reads Moc (%) and Styl from the hidden sibling panel of the fixture', () => {
    const dziki = cards.find((c) => c.name.includes('UKRYKA'))!;
    expect(dziki.abv).toBe(4.5);
    expect(dziki.style).toBe('Wheat beer');
  });

  it('reads style even when the product publishes no Moc row', () => {
    const pinta = cards.find((c) => c.name.includes('WEST COAST IPA'))!;
    expect(pinta.abv).toBeUndefined();
    expect(pinta.style).toBe('West Coast IPA');
  });

  // Real capture of https://onemorebeer.pl/bezalkoholowe/inne — the page orphan 29552
  // (AleBrowar KWAS CHLEBOWY JASNY) was scraped from. Regenerate with
  // `npm run capture-omb-abv`. Real markup rather than a synthetic tile, so this also
  // pins the wrapper/panel structure the adapter depends on.
  // Asserts the invariant the fixture exists to pin — a published 0.0% parses to 0 and
  // not undefined — deliberately NOT which breweries or styles are in stock. The shop's
  // inventory rotates, so asserting "AleBrowar is present" or "every style is Kwas
  // Chlebowy" would make a routine re-capture fail the test for no real reason. The
  // capture script guarantees exactly this much: at least one 0.0% product carrying a style.
  it('parses a real 0.0% product as 0, not undefined', () => {
    const abvHtml = readFileSync(resolve(__dirname, '../../tests/fixtures/onemorebeer.abv.html'), 'utf8');
    const parsed = onemorebeer.parseCards(new DOMParser().parseFromString(abvHtml, 'text/html'));
    expect(parsed.length).toBeGreaterThan(0);

    const zero = parsed.filter((c) => c.abv === 0); // MUST be 0 — a falsy check here breaks #322
    expect(zero.length).toBeGreaterThan(0);
    for (const card of zero) {
      expect(card.abv).toBe(0);
      expect(card.abv).not.toBeUndefined();
      expect(card.brewery.length).toBeGreaterThan(0);
    }

    // Style parses alongside abv from the same panel. Only "at least one" — that is what
    // the capture guard promises, and a 0.0% product legitimately need not publish a Styl
    // row (the main onemorebeer fixture contains such a product).
    expect(zero.some((c) => c.style)).toBe(true);

    // No card may come back with a non-zero ABV it did not publish.
    for (const card of parsed) {
      if (card.abv !== undefined) expect(Number.isFinite(card.abv)).toBe(true);
    }
  });

  it('accepts a comma decimal separator', () => {
    const doc = new DOMParser().parseFromString(
      `<div class="one-catalog-view-list">${wrappedTile('Pinta', 'PINTA MYSTERY BUT. 0,5 L', [
        ['Moc (%)', '4,8 %'],
      ])}</div>`,
      'text/html',
    );
    expect(onemorebeer.parseCards(doc)[0].abv).toBe(4.8);
  });

  it('ignores an unparseable Moc value without throwing', () => {
    const doc = new DOMParser().parseFromString(
      `<div class="one-catalog-view-list">${wrappedTile('Pinta', 'PINTA MYSTERY BUT. 0,5 L', [
        ['Moc (%)', 'n/d'],
      ])}</div>`,
      'text/html',
    );
    const parsed = onemorebeer.parseCards(doc);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].abv).toBeUndefined();
  });

  it('leaves both fields undefined when there is no panel at all', () => {
    const doc = new DOMParser().parseFromString(
      `<div class="one-catalog-view-list">${tile('Pinta', 'PINTA MYSTERY BUT. 0,5 L')}</div>`,
      'text/html',
    );
    const parsed = onemorebeer.parseCards(doc);
    expect(parsed[0].abv).toBeUndefined();
    expect(parsed[0].style).toBeUndefined();
  });
});

// #369 review follow-up: an impossible shop value must not become a Card.abv at all.
describe('onemorebeer ABV bounds (#369)', () => {
  it.each([['9999%', '9999%'], ['negative', '-5%']])(
    'drops an out-of-range Moc value (%s)',
    (_label, value) => {
      const doc = new DOMParser().parseFromString(
        `<div class="one-catalog-view-list">${wrappedTile('Pinta', 'PINTA MYSTERY BUT. 0,5 L', [
          ['Moc (%)', value],
        ])}</div>`,
        'text/html',
      );
      expect(onemorebeer.parseCards(doc)[0].abv).toBeUndefined();
    },
  );

  it('still keeps a legitimate 0.0%', () => {
    const doc = new DOMParser().parseFromString(
      `<div class="one-catalog-view-list">${wrappedTile('AleBrowar', 'ALEBROWAR KWAS CHLEBOWY JASNY BUT. 0,5 L', [
        ['Moc (%)', '0.0%'],
      ])}</div>`,
      'text/html',
    );
    expect(onemorebeer.parseCards(doc)[0].abv).toBe(0);
  });
});
