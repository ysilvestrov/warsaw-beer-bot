import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { onemorebeer } from './onemorebeer';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/onemorebeer-piwa.html'), 'utf8');

let cards: ReturnType<typeof onemorebeer.parseCards>;
beforeAll(() => {
  cards = onemorebeer.parseCards(new DOMParser().parseFromString(html, 'text/html'));
});

describe('onemorebeer adapter', () => {
  it('parses the rendered tiles', () => {
    expect(cards.length).toBeGreaterThanOrEqual(7);
  });

  it('extracts a non-empty brewery and name per tile', () => {
    for (const c of cards) {
      expect(c.brewery.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it('keeps the degree-ABV token and packaging tail out of the name', () => {
    for (const c of cards) {
      expect(c.name).not.toMatch(/°/);
      expect(c.name).not.toMatch(/\b(BUT|PUSZ)\b/i);
    }
  });

  it('parses ABV from the title degree token when present', () => {
    const withAbv = cards.filter((c) => c.abv !== undefined);
    expect(withAbv.length).toBeGreaterThan(0);
    for (const c of withAbv) {
      expect(typeof c.abv).toBe('number');
      expect(c.abv as number).toBeGreaterThan(0);
      expect(c.abv as number).toBeLessThan(30);
    }
  });

  it('defines waitForGrid and reRenderContainerSelector (SPA)', () => {
    expect(typeof onemorebeer.waitForGrid).toBe('function');
    expect(typeof onemorebeer.reRenderContainerSelector).toBe('string');
  });
});
