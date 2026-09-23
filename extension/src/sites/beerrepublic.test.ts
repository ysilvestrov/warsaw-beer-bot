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

  it('does not define waitForGrid (SSR)', () => {
    expect(beerrepublic.waitForGrid).toBeUndefined();
  });

  it('marks non-beer pack, variety pack, and calendar products', () => {
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

    const parsed = beerrepublic.parseCards(doc);
    expect(parsed.filter((card) => card.nonBeer)).toHaveLength(5);
    expect(parsed.filter((card) => !card.nonBeer).map((card) => card.name)).toEqual([
      'Mind Haze Galaxy Bender',
    ]);
    expect(parsed.filter((card) => card.nonBeer).every((card) => card.skip === undefined)).toBe(true);
  });
});
