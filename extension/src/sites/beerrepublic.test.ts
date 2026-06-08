import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beerrepublic } from './beerrepublic';

const html = readFileSync(
  resolve(__dirname, '../../tests/fixtures/beerrepublic-collection.html'),
  'utf8',
);

function parseFixture() {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return beerrepublic.parseCards(doc);
}

let cards: ReturnType<typeof beerrepublic.parseCards>;
beforeAll(() => { cards = parseFixture(); });

describe('beerrepublic adapter', () => {
  it('parses many cards from the SSR grid', () => {
    expect(cards.length).toBeGreaterThan(20);
  });

  it('extracts a non-empty name and an element for every card', () => {
    for (const c of cards) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.el).toBeInstanceOf(HTMLElement);
    }
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
});
