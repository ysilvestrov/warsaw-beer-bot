import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { winetime } from './winetime';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/winetime.html'), 'utf8');
const CATEGORY_ASSIGNMENT_RE = /window\.initialData\.category\s*=/;

function withoutInitialData(source: string): string {
  expect(source).toMatch(CATEGORY_ASSIGNMENT_RE);
  return source.replace(CATEGORY_ASSIGNMENT_RE, 'window.initialData.disabledCategory =');
}

function withVisibleBrewery(source: string, productKey: string, brewery: string): string {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const card = doc.querySelector(`[data-productkey="${productKey}"]`)?.closest('a.product-micro');
  if (!card) throw new Error(`Missing WineTime fixture card for product key ${productKey}`);

  const rows = Array.from(card.querySelectorAll('.j-grow-1-xs.j-size-0\\.75-xs'));
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`Missing visible brewery row for product key ${productKey}`);

  row.textContent = brewery;
  return doc.documentElement.outerHTML;
}

let cards: ReturnType<typeof winetime.parseCards>;
beforeAll(() => {
  cards = winetime.parseCards(new DOMParser().parseFromString(html, 'text/html'));
});

describe('winetime adapter', () => {
  it('matches WineTime hosts', () => {
    expect(winetime.hostMatch(new URL('https://winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo'))).toBe(true);
    expect(winetime.hostMatch(new URL('https://www.winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo'))).toBe(true);
    expect(winetime.hostMatch(new URL('https://example.com/'))).toBe(false);
  });

  it('parses WineTime product cards from the fixture', () => {
    expect(cards.length).toBeGreaterThan(20);
    for (const card of cards) {
      expect(card.el).toBeInstanceOf(HTMLElement);
      expect(card.name.length).toBeGreaterThan(0);
    }
  });

  it('uses embedded manufacturer metadata for brewery', () => {
    const doc = new DOMParser().parseFromString(withVisibleBrewery(html, '10469', 'Wrong Visible Brewery'), 'text/html');
    const parsed = winetime.parseCards(doc);

    expect(parsed).toContainEqual(
      expect.objectContaining({
        brewery: 'Meteor',
        name: 'Pils',
      }),
    );
  });

  it('cleans Ukrainian category descriptors conservatively', () => {
    expect(cards).toContainEqual(
      expect.objectContaining({
        brewery: 'Underwood Brewery',
        name: 'Ukrainian Tomato Gose',
      }),
    );
  });

  it('keeps packaging words that are part of the product label', () => {
    expect(cards).toContainEqual(
      expect.objectContaining({
        brewery: 'Meteor',
        name: 'IPA CAN',
      }),
    );
  });

  it('falls back to visible DOM text when embedded product metadata is unavailable', () => {
    const doc = new DOMParser().parseFromString(withoutInitialData(html), 'text/html');
    const parsed = winetime.parseCards(doc);

    expect(parsed.length).toBeGreaterThan(20);
    expect(parsed).toContainEqual(
      expect.objectContaining({
        brewery: 'Meteor',
        name: 'Pils',
      }),
    );
  });

  it('does not define waitForGrid because WineTime renders cards in SSR HTML', () => {
    expect(winetime.waitForGrid).toBeUndefined();
  });
});
