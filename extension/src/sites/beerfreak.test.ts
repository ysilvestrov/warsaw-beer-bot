import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beerfreak, parseProductAbv } from './beerfreak';

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

function docWithProductCount(count: number): Document {
  const products = Array.from({ length: count }, (_, i) => ({
    id: 10_000 + i,
    brand_title: 'FUNKY FLUID (Польща)',
    title: `Funky Fluid Ambrosia ${i}`,
    url: `https://beerfreak.org/funky-fluid-ambrosia-${i}/`,
  }));
  return new DOMParser().parseFromString(`
    <div data-catalog-view-block="products">
      ${products.map((product) => metadataCard(product.id, product.title)).join('')}
    </div>
    <script>
      products = ${JSON.stringify(products)},
      ids = [];
    </script>
  `, 'text/html');
}

const PRODUCT_PAGE_WITH_ABV = `
  <table>
    <tr class="product-features__row">
      <th class="product-features__cell product-features__cell--h">
        <span class="product-features__cell-title">Міцність</span>
      </th>
      <td class="product-features__cell">7.30</td>
    </tr>
  </table>
`;

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
  beforeEach(() => {
    vi.restoreAllMocks();
  });

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

  it('parses ABV from the product strength row', () => {
    const doc = new DOMParser().parseFromString(PRODUCT_PAGE_WITH_ABV, 'text/html');

    expect(parseProductAbv(doc)).toBe(7.3);
  });

  it('leaves malformed or missing product strength undefined', () => {
    expect(parseProductAbv(new DOMParser().parseFromString('', 'text/html'))).toBeUndefined();
    expect(parseProductAbv(new DOMParser().parseFromString(`
      <tr class="product-features__row">
        <th><span class="product-features__cell-title">Міцність</span></th>
        <td class="product-features__cell">strong</td>
      </tr>
    `, 'text/html'))).toBeUndefined();
  });

  it('loads ABV from bounded product details requests', async () => {
    const parsed = beerfreak.parseCards(docWithProductCount(21));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => PRODUCT_PAGE_WITH_ABV,
    } as Response);

    await beerfreak.loadCardDetails?.(parsed);

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(parsed.slice(0, 20).every((card) => card.abv === 7.3)).toBe(true);
    expect(parsed[20].abv).toBeUndefined();
  });

  it('does not define waitForGrid (SSR)', () => {
    expect(beerfreak.waitForGrid).toBeUndefined();
  });
});
