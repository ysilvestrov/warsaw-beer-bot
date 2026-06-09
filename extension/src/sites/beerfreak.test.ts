import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beerfreak } from './beerfreak';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/beerfreak.html'), 'utf8');

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

  it('falls back to card title text when embedded product metadata is absent', () => {
    const doc = new DOMParser().parseFromString(html.replace(/products = \[[\s\S]*?\],\n    ids = \[[\s\S]*?\];/, ''), 'text/html');
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
