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
});
