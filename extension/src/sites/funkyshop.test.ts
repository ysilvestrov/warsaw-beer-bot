import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { funkyshop } from './funkyshop';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/funkyshop.html'), 'utf8');
const nonBeerHtml = readFileSync(resolve(__dirname, '../../tests/fixtures/funkyshop.nonbeer.html'), 'utf8');

function parse(source: string) {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  return funkyshop.parseCards(doc);
}

let cards: ReturnType<typeof funkyshop.parseCards>;
beforeAll(() => {
  cards = parse(html);
});

describe('funkyshop adapter', () => {
  it('matches Funkyshop hosts', () => {
    expect(funkyshop.hostMatch(new URL('https://funkyshop.pl/pl/4-piwo-rzemieslnicze'))).toBe(true);
    expect(funkyshop.hostMatch(new URL('https://www.funkyshop.pl/en/4-craft-beer'))).toBe(true);
    expect(funkyshop.hostMatch(new URL('https://example.com/'))).toBe(false);
  });

  it('parses beer cards from the PrestaShop product grid', () => {
    expect(cards.length).toBeGreaterThan(20);
    expect(cards[0]).toMatchObject({
      brewery: 'Ziemia Obiecana',
      name: 'Kiełbasa Kolega (x Hop Hooligans)',
      abv: 9.6,
    });
  });

  it('strips package volume from names but keeps meaningful collaborators', () => {
    expect(cards).toContainEqual(
      expect.objectContaining({
        brewery: 'PINTA',
        name: 'Perfect Piece (x Other Half)',
        abv: 6.5,
      }),
    );
  });

  it('drops beer sets from beer category grids', () => {
    expect(cards.map((c) => c.name)).not.toContain('Lervig Rackhouse Barrel Aged Set');
    expect(cards.map((c) => c.name)).not.toContain("Gelato Week '26 Set");
  });

  it('treats issue-listed glass merch categories as whole non-beer pages', () => {
    expect(funkyshop.isNonBeerPage?.(new URL('https://funkyshop.pl/pl/17-szklomerch'))).toBe(true);
    expect(funkyshop.isNonBeerPage?.(new URL('https://funkyshop.pl/en/17-glassmerch'))).toBe(true);
    expect(funkyshop.isNonBeerPage?.(new URL('https://funkyshop.pl/pl/4-piwo-rzemieslnicze'))).toBe(false);
  });

  it('drops glass and merch products from the non-beer fixture', () => {
    expect(parse(nonBeerHtml)).toEqual([]);
  });
});
