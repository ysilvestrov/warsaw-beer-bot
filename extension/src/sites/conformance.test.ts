import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADAPTERS } from './registry';
import { startOverlay } from '../content/main';
import { runOverlay } from '../content/index';
import type { MatchResult, RawBeer } from '../api/types';

const fixturePath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.html`);
const nonBeerHtmlPath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.nonbeer.html`);
const waitForBadge = () => vi.waitFor(
  () => expect(document.querySelector('[data-beerbadge]')).not.toBeNull(),
  { timeout: 5_000 },
);

// Load a fixture's <body> into the live jsdom document so MutationObserver works.
function mountFixture(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

// Mark the first beer of each request drunk so badges appear deterministically.
const sendMatch = (cards: RawBeer[]): Promise<MatchResult[]> =>
  Promise.resolve(
    cards.map((raw, i) => ({
      raw: { brewery: raw.brewery, name: raw.name },
      matched_beer: null,
      is_drunk: i === 0,
      drunk_uncertain: false,
      user_rating: i === 0 ? 4 : null,
      source: null,
      searched: true,
    })),
  );

beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, text: async () => '' } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(ADAPTERS.map((a) => [a.id, a] as const))('adapter contract: %s', (id, adapter) => {
  it('has a fixture at tests/fixtures/<id>.html', () => {
    expect(existsSync(fixturePath(id))).toBe(true);
  });

  it('parses at least one well-formed card from its fixture', () => {
    const parsed = new DOMParser().parseFromString(readFileSync(fixturePath(id), 'utf8'), 'text/html');
    const cards = adapter.parseCards(parsed);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((card) => !card.nonBeer && card.name.length > 0)).toBe(true);
    for (const c of cards) {
      if (c.nonBeer) {
        expect(c.skip).toBe(true);
      } else {
        expect(c.name.length).toBeGreaterThan(0);
      }
      expect(c.el).toBeInstanceOf(HTMLElement); // global; jsdom shares one realm
    }
  });

  it('reRenderContainerSelector, when set, matches a node in the fixture', () => {
    if (!adapter.reRenderContainerSelector) return;
    const parsed = new DOMParser().parseFromString(readFileSync(fixturePath(id), 'utf8'), 'text/html');
    expect(parsed.querySelector(adapter.reRenderContainerSelector)).not.toBeNull();
  });

  it('returns confirmed per-card non-beer products (or preserves a whole-page exception)', async () => {
    expect(existsSync(nonBeerHtmlPath(id))).toBe(true);
    const doc = new DOMParser().parseFromString(readFileSync(nonBeerHtmlPath(id), 'utf8'), 'text/html');

    if (id === 'beershop') {
      expect(adapter.parseCards(doc)).toEqual([]);
      return;
    }

    const cards = adapter.parseCards(doc);
    if (id === 'flasker') {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        text: async () =>
          '<span class="posted_in"><a href="https://flasker.com.ua/product-category/suveniry/">Сувеніри</a></span>',
      } as Response);
      await adapter.loadCardDetails?.(cards);
    }
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.nonBeer && card.skip)).toBe(true);
  });

  it('renders confirmed non-beer cards without matching them', async () => {
    if (id === 'beershop') return;
    const doc = new DOMParser().parseFromString(readFileSync(nonBeerHtmlPath(id), 'utf8'), 'text/html');
    const match = vi.fn(sendMatch);

    if (id === 'flasker') {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        text: async () =>
          '<span class="posted_in"><a href="https://flasker.com.ua/product-category/suveniry/">Сувеніри</a></span>',
      } as Response);
    }

    await runOverlay(doc, adapter, match);

    const cards = adapter.parseCards(doc);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.el.querySelector('[data-beerbadge]')?.textContent === '✕')).toBe(true);
    expect(cards.every((card) => card.el.hasAttribute('data-beerseen'))).toBe(true);
    expect(match).not.toHaveBeenCalled();
  });

  it('re-badges after the grid is replaced with fresh nodes', async () => {
    const html = readFileSync(fixturePath(id), 'utf8');
    mountFixture(html);
    const stop = startOverlay(document, adapter, sendMatch, { debounceMs: 10 });
    await waitForBadge();

    // synthesize AJAX navigation: identical content, fresh badge-less nodes
    mountFixture(html);
    expect(document.querySelector('[data-beerbadge]')).toBeNull();
    await waitForBadge();
    stop();
  });
});
