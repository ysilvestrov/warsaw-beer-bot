import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beerfreak } from './beerfreak';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/beerfreak.html'), 'utf8');
const PRODUCT_METADATA_RE = /products = \[[\s\S]*?\],\n    ids = \[[\s\S]*?\];/;

function withoutProductMetadata(source: string): string {
  expect(source).toMatch(PRODUCT_METADATA_RE);
  return source.replace(PRODUCT_METADATA_RE, '');
}

function metadataCard(id: number, title: string): string {
  return `
    <div class="catalogCard j-catalog-card">
      <div class="j-product-container" data-id="${id}"></div>
      <a class="catalogCard-title">${title}</a>
    </div>
  `;
}

function docWithProducts(products: unknown[]): Document {
  return new DOMParser().parseFromString(`
    <div data-catalog-view-block="products">
      ${metadataCard(1737, 'fallback title')}
      ${metadataCard(10079, 'fallback title')}
      ${metadataCard(10112, 'fallback title')}
    </div>
    <script>
      products = ${JSON.stringify(products)},
      ids = [];
    </script>
  `, 'text/html');
}

let cards: ReturnType<typeof beerfreak.parseCards>;
beforeAll(() => {
  cards = beerfreak.parseCards(new DOMParser().parseFromString(html, 'text/html'));
});

describe('beerfreak adapter', () => {
  it('parses the Horoshop catalog cards', () => {
    expect(cards.length).toBeGreaterThan(20);
  });

  it('uses embedded product metadata for brewery and name', () => {
    expect(cards[0]).toMatchObject({
      brewery: 'VOLTA BREWERY',
      name: 'SMOOTHIE BEAST: RED CURRANT, YUZU, BLUEBERRY, RASPBERRY, BERGAMOT',
    });
  });

  it('keeps collab slash names intact when metadata has no brewery', () => {
    const collab = cards.find((c) => c.name.includes('Popihn/Brasserie Cambier'));
    expect(collab).toMatchObject({
      brewery: '',
      name: 'Popihn/Brasserie Cambier DIPA DDH - DOLCITA',
    });
  });

  it('removes brewery suffix noise that remains after brand prefix trimming', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 1737, brand_title: 'ДІДЬКО (Україна)', title: 'Дідько Brewery Double Trouble' },
      { id: 10079, brand_title: 'TEN MEN (Україна)', title: 'Ten Men Brewery RUBIS' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'ДІДЬКО',
      name: 'Double Trouble',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'TEN MEN',
      name: 'RUBIS',
    }));
  });

  it('extracts a brewery prefix from Beerfreak titles when metadata has no brand', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 10112, brand_title: null, title: 'Brouwerij De Dolle Brouwers Oerbier' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'Brouwerij De Dolle Brouwers',
      name: 'Oerbier',
    }));
  });

  it('falls back to card title text when embedded product metadata is absent', () => {
    const doc = new DOMParser().parseFromString(withoutProductMetadata(html), 'text/html');
    const parsed = beerfreak.parseCards(doc);

    expect(parsed.length).toBeGreaterThan(20);
    expect(parsed[0]).toMatchObject({
      brewery: '',
      name: 'Volta Brewery SMOOTHIE BEAST: RED CURRANT, YUZU, BLUEBERRY, RASPBERRY, BERGAMOT',
    });
  });

  it('does not define waitForGrid (SSR)', () => {
    expect(beerfreak.waitForGrid).toBeUndefined();
  });
});
