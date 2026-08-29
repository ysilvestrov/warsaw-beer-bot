import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pickAdapter } from './registry';

const beerHtml = readFileSync(resolve(__dirname, '../../tests/fixtures/beershop.html'), 'utf8');
const nonBeerHtml = readFileSync(resolve(__dirname, '../../tests/fixtures/beershop.nonbeer.html'), 'utf8');

function adapterFor(url = 'https://www.beershop.pl/katalog-piv') {
  const adapter = pickAdapter(new URL(url));
  expect(adapter?.id).toBe('beershop');
  return adapter;
}

function productHtml(categoryId: number, brewery = 'Klín', name = '12° Berry Sour Ale'): string {
  return `
    <script>var upgates = {"category":{"id":"${categoryId}"}};</script>
    <div class="p-l-boxes">
      <article class="card card-item" data-product-id="1">
        <h4 class="p-i-header"><a href="/p/test"><strong>${brewery}</strong><br>${name}</a></h4>
      </article>
    </div>
  `;
}

describe('beershop adapter', () => {
  it.each([
    'https://beershop.pl/katalog-piv',
    'https://www.beershop.cz/katalog-piv',
    'https://shop.beershop.sk/katalog-piv',
    'https://www.beershop.eu/beer-list',
    'https://beershop.de/bierkatalog',
  ])('matches the supported language host %s', (url) => {
    expect(adapterFor(url)?.id).toBe('beershop');
  });

  it('does not match lookalike hosts', () => {
    expect(pickAdapter(new URL('https://beershop.pl.example.com/katalog-piv'))).toBeNull();
  });

  it('parses brewery and beer name from the live catalog fixture', () => {
    const adapter = adapterFor();
    if (!adapter) return;

    const doc = new DOMParser().parseFromString(beerHtml, 'text/html');
    const cards = adapter.parseCards(doc);

    expect(cards.length).toBeGreaterThan(20);
    expect(cards[0]).toMatchObject({
      brewery: 'Klín',
      name: '12° Berry Sour Ale',
    });
  });

  it.each([132, 150, 151, 152, 153, 154, 263, 267, 268, 134, 135, 155, 220, 258, 275])(
    'drops every product from non-beer category id %i',
    (categoryId) => {
      const adapter = adapterFor();
      if (!adapter) return;
      const doc = new DOMParser().parseFromString(productHtml(categoryId), 'text/html');
      expect(adapter.parseCards(doc)).toEqual([]);
    },
  );

  it('reads the page category id when parsing a re-rendered product grid', () => {
    const adapter = adapterFor();
    if (!adapter) return;
    const doc = new DOMParser().parseFromString(productHtml(150), 'text/html');
    const grid = doc.querySelector('.p-l-boxes');
    expect(grid).not.toBeNull();
    if (!grid) return;

    expect(adapter.parseCards(grid)).toEqual([]);
  });

  it('drops the live lemonade and cola fixture', () => {
    const adapter = adapterFor();
    if (!adapter) return;
    const doc = new DOMParser().parseFromString(nonBeerHtml, 'text/html');
    expect(adapter.parseCards(doc)).toEqual([]);
  });

  it('drops shared non-beer pack names from otherwise eligible grids', () => {
    const adapter = adapterFor();
    if (!adapter) return;
    const doc = new DOMParser().parseFromString(productHtml(156, 'Beershop', 'World Beer Gift Pack'), 'text/html');
    expect(adapter.parseCards(doc)).toEqual([]);
  });

  it.each([
    'https://www.beershop.pl/limonady-coly',
    'https://www.beershop.pl/limonady',
    'https://www.beershop.pl/coly',
    'https://www.beershop.pl/toniky',
    'https://www.beershop.pl/funkcni-napoje',
    'https://www.beershop.pl/kombuchy-a-shoty',
    'https://www.beershop.pl/limonady-1',
    'https://www.beershop.pl/darky-pro-pivare',
    'https://www.beershop.pl/darkove-poukazy',
    'https://www.beershop.pl/beershop-merch',
    'https://www.beershop.pl/otwieracze',
    'https://www.beershop.pl/darkova-baleni',
    'https://www.beershop.pl/delikatesy-k-pivu',
    'https://www.beershop.cz/funkcni-napoje',
    'https://www.beershop.cz/kombuchy',
    'https://www.beershop.cz/limonady-1',
    'https://www.beershop.cz/giny-rumy',
    'https://www.beershop.cz/darky-pro-pivare',
    'https://www.beershop.cz/darkove-poukazy',
    'https://www.beershop.cz/beershop-merch',
    'https://www.beershop.cz/otviraky',
    'https://www.beershop.cz/darkova-baleni',
    'https://www.beershop.cz/delikatesy-k-pivu',
    'https://www.beershop.sk/funkcne-napoje',
    'https://www.beershop.sk/kombuchy',
    'https://www.beershop.sk/giny-rumy',
    'https://www.beershop.sk/darceky-pre-pivarov',
    'https://www.beershop.sk/darcekove-poukazy',
    'https://www.beershop.sk/beershop-merch',
    'https://www.beershop.sk/otvarace',
    'https://www.beershop.sk/darcekove-balenia',
    'https://www.beershop.sk/delikatesy-k-pivu',
    'https://www.beershop.eu/smart-drinks',
    'https://www.beershop.eu/kombuches-shots',
    'https://www.beershop.eu/gifts-for-brewerers',
    'https://www.beershop.eu/gift-vouchers',
    'https://www.beershop.eu/beershop-merch',
    'https://www.beershop.eu/openers',
    'https://www.beershop.eu/gift-packs',
    'https://www.beershop.de/smart-drinks',
    'https://www.beershop.de/kombuches-shots',
    'https://www.beershop.de/gifts-for-brewerers',
    'https://www.beershop.de/gift-vouchers',
    'https://www.beershop.de/beershop-merch',
    'https://www.beershop.de/openers',
    'https://www.beershop.de/gift-packs',
  ])('treats localized non-beer route %s as a whole non-beer page', (url) => {
    expect(adapterFor(url)?.isNonBeerPage?.(new URL(url))).toBe(true);
  });

  it.each([
    'https://www.beershop.pl/katalog-piv',
    'https://www.beershop.pl/cidery',
    'https://www.beershop.pl/nealko-pivo-radlery',
    'https://www.beershop.eu/beer-list',
  ])('keeps eligible drink route %s', (url) => {
    expect(adapterFor(url)?.isNonBeerPage?.(new URL(url))).toBe(false);
  });
});
