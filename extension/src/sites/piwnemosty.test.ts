import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { piwnemosty } from './piwnemosty';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/piwnemosty.html'), 'utf8');
const nonBeerHtml = readFileSync(resolve(__dirname, '../../tests/fixtures/piwnemosty.nonbeer.html'), 'utf8');
const VIEW_ITEM_LIST_RE = /gtag\("event", "view_item_list", /;

function withoutItemMetadata(source: string): string {
  expect(source).toMatch(VIEW_ITEM_LIST_RE);
  return source.replace(VIEW_ITEM_LIST_RE, 'gtag("event", "disabled_item_list", ');
}

function withVisibleTitle(source: string, productId: string, title: string): string {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const card = doc.querySelector(`.product[data-product_id="${productId}"]`);
  if (!card) throw new Error(`Missing Piwne Mosty fixture card for product ${productId}`);

  const link = card.querySelector('.product__name');
  if (!link) throw new Error(`Missing Piwne Mosty title link for product ${productId}`);
  link.textContent = title;
  link.setAttribute('title', title);
  return doc.documentElement.outerHTML;
}

function productHtml({
  id,
  title,
  brand,
}: {
  id: string;
  title: string;
  brand: string;
}): string {
  return `
    <div id="search" class="products">
      <div class="product" data-product_id="${id}">
        <a class="product__name" title="${title}">${title}</a>
      </div>
    </div>
    <script>
      gtag("event", "view_item_list", {
        "items": [
          {
            "item_id": "${id}",
            "item_name": "${title}",
            "item_brand": "${brand}",
            "item_category": "Piwo"
          }
        ]
      });
    </script>
  `;
}

let cards: ReturnType<typeof piwnemosty.parseCards>;
beforeAll(() => {
  cards = piwnemosty.parseCards(new DOMParser().parseFromString(html, 'text/html'));
});

describe('piwnemosty adapter', () => {
  it('matches Piwne Mosty hosts', () => {
    expect(piwnemosty.hostMatch(new URL('https://piwnemosty.pl/pol_m_PIWO-KRAFTOWE-100.html'))).toBe(true);
    expect(piwnemosty.hostMatch(new URL('https://www.piwnemosty.pl/pol_m_PIWO-KRAFTOWE-100.html'))).toBe(true);
    expect(piwnemosty.hostMatch(new URL('https://example.com/'))).toBe(false);
  });

  it('parses beer cards from the fixture', () => {
    expect(cards.length).toBeGreaterThan(20);
    expect(cards[0]).toMatchObject({
      brewery: 'Browar Magic Road',
      name: 'Szpont',
    });
  });

  it('uses embedded item metadata for brewery and title', () => {
    const doc = new DOMParser().parseFromString(withVisibleTitle(html, '12051', 'Wrong Visible Brewery: Wrong Beer'), 'text/html');
    const parsed = piwnemosty.parseCards(doc);

    expect(parsed[0]).toMatchObject({
      brewery: 'Browar Magic Road',
      name: 'Szpont',
    });
  });

  it('falls back to visible DOM title when embedded item metadata is unavailable', () => {
    const doc = new DOMParser().parseFromString(withoutItemMetadata(html), 'text/html');
    const parsed = piwnemosty.parseCards(doc);

    expect(parsed.length).toBeGreaterThan(20);
    expect(parsed[0]).toMatchObject({
      brewery: 'Magic Road',
      name: 'Szpont',
    });
  });

  it('keeps collaborator brewery in the beer name after the primary brewery prefix', () => {
    expect(cards).toContainEqual(
      expect.objectContaining({
        brewery: 'Browar Magic Road',
        name: 'x Upside Down: Road to Upside',
      }),
    );
  });

  it('skips cards that only contain out-of-stock placeholders', () => {
    const doc = new DOMParser().parseFromString(
      productHtml({
        id: '31622',
        title: 'Wypite',
        brand: 'Chwilowy Brak:( Brewery',
      }),
      'text/html',
    );

    expect(piwnemosty.parseCards(doc)).toEqual([]);
  });

  it('strips out-of-stock placeholders while keeping the real beer title', () => {
    const doc = new DOMParser().parseFromString(
      productHtml({
        id: '30931',
        title: 'Guinness Chwilowy brak:(',
        brand: '-',
      }),
      'text/html',
    );

    expect(piwnemosty.parseCards(doc)).toEqual([
      expect.objectContaining({
        brewery: '',
        name: 'Guinness',
      }),
    ]);
  });

  it('strips multiple out-of-stock placeholders from a real beer title', () => {
    const doc = new DOMParser().parseFromString(
      productHtml({
        id: '30933',
        title: 'Guinness Chwilowy brak:( Wypite',
        brand: '-',
      }),
      'text/html',
    );

    expect(piwnemosty.parseCards(doc)).toEqual([
      expect.objectContaining({
        brewery: '',
        name: 'Guinness',
      }),
    ]);
  });

  it('keeps an exact Brewery brand when it did not come from an out-of-stock placeholder', () => {
    const doc = new DOMParser().parseFromString(
      productHtml({
        id: '30934',
        title: 'Brewery: House Lager',
        brand: 'Brewery',
      }),
      'text/html',
    );

    expect(piwnemosty.parseCards(doc)).toEqual([
      expect.objectContaining({
        brewery: 'Brewery',
        name: 'House Lager',
      }),
    ]);
  });

  it('keeps valid titles that only contain one out-of-stock marker word', () => {
    const doc = new DOMParser().parseFromString(
      productHtml({
        id: '30932',
        title: 'Chwilowy Porter: Brak Point',
        brand: 'Browar Chwilowy',
      }),
      'text/html',
    );

    expect(piwnemosty.parseCards(doc)).toEqual([
      expect.objectContaining({
        brewery: 'Browar Chwilowy',
        name: 'Porter: Brak Point',
      }),
    ]);
  });

  it('treats the issue-listed snack and merch categories as whole non-beer pages', () => {
    expect(piwnemosty.isNonBeerPage?.(new URL('https://www.piwnemosty.pl/pol_m_PRZEKASKI-160.html'))).toBe(true);
    expect(piwnemosty.isNonBeerPage?.(new URL('https://www.piwnemosty.pl/pol_m_PRZEKASKI_Chipsy-161.html'))).toBe(true);
    expect(piwnemosty.isNonBeerPage?.(new URL('https://www.piwnemosty.pl/pol_m_SZKLO-I-MERCH-167.html'))).toBe(true);
    expect(piwnemosty.isNonBeerPage?.(new URL('https://www.piwnemosty.pl/pol_m_SZKLO-I-MERCH_Bony-podarunkowe-293.html'))).toBe(true);
    expect(piwnemosty.isNonBeerPage?.(new URL('https://www.piwnemosty.pl/pol_m_PIWO-KRAFTOWE-100.html'))).toBe(false);
  });

  it('drops non-beer products from the non-beer fixture', () => {
    const doc = new DOMParser().parseFromString(nonBeerHtml, 'text/html');
    expect(piwnemosty.parseCards(doc)).toEqual([]);
  });
});
