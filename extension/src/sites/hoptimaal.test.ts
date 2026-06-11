import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hoptimaal } from './hoptimaal';

const html = readFileSync(
  resolve(__dirname, '../../tests/fixtures/hoptimaal.html'),
  'utf8',
);

function parseFixture() {
  return hoptimaal.parseCards(new DOMParser().parseFromString(html, 'text/html'));
}

function card(title: string, url: string, subtitle = 'Stout | 12% | 33cl | UT: 4,39'): string {
  return `
    <div class="product-item" data-title="${title}" data-url="${url}">
      <h3 class="product-item__product-title"><a href="${url}">${title}</a></h3>
      <h4 class="product-item__subtitle">${subtitle}</h4>
    </div>
  `;
}

describe('hoptimaal adapter', () => {
  it('parses many beer cards from the SSR collection fixture', () => {
    const cards = parseFixture();
    expect(cards.length).toBeGreaterThan(40);
    expect(cards.every((c) => c.brewery.length > 0)).toBe(true);
    expect(cards).toContainEqual(expect.objectContaining({
      brewery: 'PINTA Barrel Brewing',
      name: 'Patience 5th Anniversary (2026)',
      abv: 12,
    }));
    expect(cards).toContainEqual(expect.objectContaining({
      brewery: 'Verdant Brewing Co',
      name: 'Flux: Phase 6',
    }));
  });

  it('extracts brewery prefixes when the title starts with a brewery descriptor', () => {
    const cards = hoptimaal.parseCards(new DOMParser().parseFromString([
      card('Cervejaria Fermi Ladybug - Morning Glory Series (2026)', '/en/collections/craft-beers/products/fermi-ladybug'),
      card('The Piggy Brewing Company QG Torpedo', '/en/collections/craft-beers/products/piggy-qg-torpedo'),
      card('Salikatt Black Silk', '/en/collections/craft-beers/products/salikatt-black-silk'),
    ].join(''), 'text/html'));

    expect(cards).toContainEqual(expect.objectContaining({
      brewery: 'Cervejaria Fermi',
      name: 'Ladybug - Morning Glory Series (2026)',
    }));
    expect(cards).toContainEqual(expect.objectContaining({
      brewery: 'The Piggy Brewing Company',
      name: 'QG Torpedo',
    }));
    expect(cards).toContainEqual(expect.objectContaining({
      brewery: 'Salikatt',
      name: 'Black Silk',
    }));
  });

  it('ignores non-beer Hoptimaal categories requested in issue #91', () => {
    const cards = hoptimaal.parseCards(new DOMParser().parseFromString([
      card('Hoptimaal Beer Club Subscription', '/en/collections/abonnement/products/beer-club'),
      card('Hoptimaal T-shirt', '/en/collections/merch/products/hoptimaal-t-shirt'),
      card('Bourbon Whiskey', '/en/collections/spirits/products/bourbon-whiskey'),
      card('IPA Tasting Bundle', '/en/collections/beer-packages/products/ipa-tasting-bundle'),
      card('PINTA Barrel Brewing Patience 5th Anniversary (2026)', '/en/collections/craft-beers/products/pinta-patience'),
    ].join(''), 'text/html'));

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      brewery: 'PINTA Barrel Brewing',
      name: 'Patience 5th Anniversary (2026)',
    });
  });
});
