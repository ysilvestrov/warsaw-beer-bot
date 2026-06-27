import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beerrepublic } from './beerrepublic';

const html = readFileSync(
  resolve(__dirname, '../../tests/fixtures/beerrepublic.html'),
  'utf8',
);

function parseFixture() {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return beerrepublic.parseCards(doc);
}

function product(title: string, vendor = 'Beer Republic'): string {
  return `
    <div class="product-item">
      <span class="product-item__vendor">${vendor}</span>
      <a class="product-item__title">${title}</a>
    </div>
  `;
}

let cards: ReturnType<typeof beerrepublic.parseCards>;
beforeAll(() => { cards = parseFixture(); });

describe('beerrepublic adapter', () => {
  it('parses many cards from the SSR grid', () => {
    expect(cards.length).toBeGreaterThan(20);
  });

  it('splits brewery (vendor) from name (title)', () => {
    const withBrewery = cards.filter((c) => c.brewery.length > 0);
    expect(withBrewery.length).toBeGreaterThan(0);
    if (withBrewery.length > 0) {
      expect(withBrewery[0].brewery).not.toEqual(withBrewery[0].name);
    }
  });

  it('does not define waitForGrid (SSR)', () => {
    expect(beerrepublic.waitForGrid).toBeUndefined();
  });

  it('ignores non-beer pack, variety pack, and calendar products', () => {
    const doc = new DOMParser().parseFromString(`
      <section data-section-type="collection">
        ${product('Limited Edition Anniversary Vertical Set', 'Firestone Walker')}
        ${product("Firestone Walker Barrel Aged Brewer's Collective Brewery Pack", 'Firestone Walker')}
        ${product('Surprise Box Barrel Aged Beers')}
        ${product('Advent Calendar 2025 Green Edition')}
        ${product('Winter Break Variety Twelve Pack', 'Samuel Adams')}
        ${product('Mind Haze Galaxy Bender', 'Firestone Walker')}
      </section>
    `, 'text/html');

    expect(beerrepublic.parseCards(doc).map((c) => c.name)).toEqual(['Mind Haze Galaxy Bender']);
  });
});
