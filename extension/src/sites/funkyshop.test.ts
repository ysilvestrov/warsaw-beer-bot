import { describe, it, expect, beforeAll, vi } from 'vitest';
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

  it('strips trailing volume plus can format from product names', () => {
    const cards = parse(`
      <article class="product-miniature">
        <p class="h3 product-title"><a href="/en/funky-shop/free-classy.html">Free Classy 500ml (can)</a></p>
        <a class="manufacturer-product">Funky Fluid</a>
        <div class="product-description-short">West Coast IPA, 6%</div>
      </article>
    `);

    expect(cards).toContainEqual(expect.objectContaining({
      brewery: 'Funky Fluid',
      name: 'Free Classy',
      abv: 6,
    }));
  });

  it('strips trailing volume plus product-detail parentheses from names', () => {
    const cards = parse(`
      <article class="product-miniature">
        <p class="h3 product-title"><a href="/en/funky-shop/gelato.html">Gelato XTREME: Jungle Juice Slushy XXL 500ml (6th Anniversary 450 North collab)</a></p>
        <a class="manufacturer-product">Funky Fluid</a>
        <div class="product-description-short">Multifruit XTREME Ice Cream Sour, 8%</div>
      </article>
    `);

    expect(cards).toContainEqual(expect.objectContaining({
      brewery: 'Funky Fluid',
      name: 'Gelato XTREME: Jungle Juice Slushy XXL',
      abv: 8,
    }));
  });

  it('drops can deposit fee rows from mixed product grids', () => {
    const cards = parse(`
      <article class="product-miniature">
        <p class="h3 product-title"><a href="/en/funky-shop/can-deposit.html">Can Deposit</a></p>
        <div class="product-description-short">Deposit fee</div>
      </article>
    `);

    expect(cards).toEqual([]);
  });

  it('hydrates missing brewery from the product detail page', async () => {
    const cards = parse(`
      <article class="product-miniature">
        <p class="h3 product-title"><a href="https://funkyshop.pl/en/funky-shop/aloha.html">Aloha 500ml</a></p>
        <div class="product-description-short">Fruited Sour, 4.5%</div>
      </article>
    `);

    expect(cards[0]).toMatchObject({ brewery: '', name: 'Aloha' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => `
        <html><body>
          <a class="manufacturer-product">Funky Fluid</a>
        </body></html>
      `,
    } as Response);

    await funkyshop.loadCardDetails?.(cards);

    expect(fetchSpy).toHaveBeenCalledWith('https://funkyshop.pl/en/funky-shop/aloha.html', { credentials: 'include' });
    expect(cards[0]).toMatchObject({ brewery: 'Funky Fluid', name: 'Aloha', abv: 4.5 });
    fetchSpy.mockRestore();
  });

  it('skips cards when a missing brewery cannot be hydrated', async () => {
    const cards = parse(`
      <article class="product-miniature">
        <p class="h3 product-title"><a href="https://funkyshop.pl/en/funky-shop/missing-brewery.html">Aloha 500ml</a></p>
        <div class="product-description-short">Fruited Sour, 4.5%</div>
      </article>
    `);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      text: async () => '',
    } as Response);

    await funkyshop.loadCardDetails?.(cards);

    expect(cards[0]).toMatchObject({ brewery: '', name: 'Aloha', skip: true });
    fetchSpy.mockRestore();
  });

  it('shares one detail fetch across cards with the same product URL', async () => {
    const cards = parse(`
      <article class="product-miniature">
        <p class="h3 product-title"><a href="https://funkyshop.pl/en/funky-shop/shared.html">Aloha 500ml</a></p>
        <div class="product-description-short">Fruited Sour, 4.5%</div>
      </article>
      <article class="product-miniature">
        <p class="h3 product-title"><a href="https://funkyshop.pl/en/funky-shop/shared.html">Free Classy 500ml</a></p>
        <div class="product-description-short">West Coast IPA, 6%</div>
      </article>
    `);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '<a class="manufacturer-product">Funky Fluid</a>',
    } as Response);

    await funkyshop.loadCardDetails?.(cards);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cards.map((card) => card.brewery)).toEqual(['Funky Fluid', 'Funky Fluid']);
    expect(cards.map((card) => card.skip)).toEqual([undefined, undefined]);
    fetchSpy.mockRestore();
  });
});
