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

  it('does not define waitForGrid (SSR)', () => {
    expect(beerfreak.waitForGrid).toBeUndefined();
  });
});
