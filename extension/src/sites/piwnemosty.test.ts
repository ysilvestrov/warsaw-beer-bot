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
