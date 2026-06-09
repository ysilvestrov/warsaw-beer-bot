import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { onemorebeer } from './onemorebeer';

const html = readFileSync(resolve(__dirname, '../../tests/fixtures/onemorebeer.html'), 'utf8');

let cards: ReturnType<typeof onemorebeer.parseCards>;
beforeAll(() => {
  cards = onemorebeer.parseCards(new DOMParser().parseFromString(html, 'text/html'));
});

describe('onemorebeer adapter', () => {
  it('parses the rendered tiles', () => {
    expect(cards.length).toBeGreaterThanOrEqual(7);
  });

  it('extracts a non-empty brewery per tile (brand-name selector quirk)', () => {
    for (const c of cards) {
      expect(c.brewery.length).toBeGreaterThan(0);
    }
  });

  it('keeps the degree-ABV token and packaging tail out of the name', () => {
    for (const c of cards) {
      expect(c.name).not.toMatch(/°/);
      expect(c.name).not.toMatch(/\b(BUT|PUSZ)\b/i);
    }
  });

  it('never sets abv (the degree token is Plato/extract, not ABV)', () => {
    for (const c of cards) {
      expect(c.abv).toBeUndefined();
    }
  });

  it('defines waitForGrid (SPA grid paints client-side)', () => {
    expect(typeof onemorebeer.waitForGrid).toBe('function');
  });
});
