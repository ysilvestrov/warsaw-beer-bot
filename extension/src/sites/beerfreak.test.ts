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

interface TestProduct {
  id: number;
  brand_title?: string | null;
  title: string;
  url?: string;
}

function docWithProducts(products: TestProduct[]): Document {
  return new DOMParser().parseFromString(`
    <div data-catalog-view-block="products">
      ${products.map((product) => metadataCard(product.id, 'fallback title')).join('')}
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

  it('uses the first brewery and strips slash collaborator prefixes when metadata has no brand', () => {
    const collab = cards.find((c) => c.name.includes('DOLCITA'));
    expect(collab).toMatchObject({
      brewery: 'Popihn',
      name: 'DIPA DDH - DOLCITA',
    });
  });

  it('splits brandless BeerFreak titles into usable brewery and beer names', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 10412, brand_title: null, title: 'RIOAZUL Scorpion' },
      { id: 10413, brand_title: null, title: 'La Quince Brewing Co./RIOAZUL Final Form' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'RIOAZUL',
      name: 'Scorpion',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'La Quince Brewing Co.',
      name: 'Final Form',
    }));
  });

  it('strips leading slash collaborator segments after the branded brewery prefix', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 10457, brand_title: 'PINTA (Польща)', title: 'PINTA/Varietal Beer Company Hazy Discovery Sunnyside' },
      { id: 10458, brand_title: 'VARVAR BREW (Україна)', title: 'VARVAR BREW\\Saugatuck Brewing Company Sugar Moon' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'PINTA',
      name: 'Hazy Discovery Sunnyside',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'VARVAR BREW',
      name: 'Sugar Moon',
    }));
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

  it('drops BeerFreak tasting sets and multi-beer packs', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 29993, brand_title: 'FUNKY FLUID (Польща)', title: 'WORLD CUP SERIES - 5 SPECIAL BEER' },
      { id: 31072, brand_title: 'ГОНІР - HONIR BREWERY (Україна)', title: 'Дегустаціний сет від Honir Brewery' },
      { id: 31073, brand_title: 'Example Brewery', title: 'Example Brewery Mix Pack' },
      { id: 31074, brand_title: 'Example Brewery', title: 'Example Brewery Tasting Set' },
    ]));

    expect(parsed).toEqual([]);
  });

  it('keeps legitimate BeerFreak beers with incidental set-like substrings', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 31075, brand_title: 'Sunset Brew', title: 'Sunset Brew Sunset Boulevard' },
      { id: 31076, brand_title: 'Reset Brewing', title: 'Reset Brewing Reset IPA' },
      { id: 31077, brand_title: 'Series Brewing', title: 'Series Brewing Special Beer' },
    ]));

    expect(parsed.map(({ brewery, name }) => ({ brewery, name }))).toEqual([
      { brewery: 'Sunset Brew', name: 'Sunset Boulevard' },
      { brewery: 'Reset Brewing', name: 'Reset IPA' },
      { brewery: 'Series Brewing', name: 'Special Beer' },
    ]);
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

  it('strips the leading brewery run when brand_title diverges from the title form', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 20001, brand_title: 'HOPPY HOG BREWERY (Україна)', title: 'Hoppy Hog Family Brewery Tropical Veil NEIPA' },
      { id: 20002, brand_title: 'BROKREACJA BREWERY (Польща)', title: 'Browar Brokreacja NAFCIARZ 19' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'HOPPY HOG BREWERY',
      name: 'Tropical Veil NEIPA',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'BROKREACJA BREWERY',
      name: 'NAFCIARZ 19',
    }));
  });

  it('does not over-strip when the title tokens do not include a brand-core token', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 20003, brand_title: 'ZZZ BREWERY (Nowhere)', title: 'Family Reunion Imperial Stout' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'ZZZ BREWERY',
      name: 'Family Reunion Imperial Stout',
    }));
  });

  it('leaves exact-prefix brands and the SHO paren-alias case unchanged (regression)', () => {
    const parsed = beerfreak.parseCards(docWithProducts([
      { id: 20004, brand_title: 'VOLTA BREWERY (Україна)', title: 'Volta Brewery MODERN PILSNER' },
      { id: 20005, brand_title: 'SHO BREWERY (Україна)', title: 'SHO Brewery (IIIO) Narcissus' },
    ]));

    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'VOLTA BREWERY',
      name: 'MODERN PILSNER',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      brewery: 'SHO BREWERY',
      name: '(IIIO) Narcissus',
    }));
  });
});
