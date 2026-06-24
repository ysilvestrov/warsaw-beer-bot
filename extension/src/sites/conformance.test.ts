import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADAPTERS } from './registry';
import { startOverlay } from '../content/main';
import type { MatchResult, RawBeer } from '../api/types';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixturePath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.html`);
const nonBeerHtmlPath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.nonbeer.html`);
const nonBeerJsonPath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.nonbeer.json`);

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
    for (const c of cards) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.el).toBeInstanceOf(HTMLElement); // global; jsdom shares one realm
    }
  });

  it('reRenderContainerSelector, when set, matches a node in the fixture', () => {
    if (!adapter.reRenderContainerSelector) return;
    const parsed = new DOMParser().parseFromString(readFileSync(fixturePath(id), 'utf8'), 'text/html');
    expect(parsed.querySelector(adapter.reRenderContainerSelector)).not.toBeNull();
  });

  it('drops non-beer products: parses zero cards from its non-beer fixture (or is exempt)', () => {
    // Exemption: a shop with verified-zero non-beers ships {none:true, reason}. Reason required so
    // an exemption is a deliberate, documented choice — not a silently skipped obligation.
    if (existsSync(nonBeerJsonPath(id))) {
      const meta = JSON.parse(readFileSync(nonBeerJsonPath(id), 'utf8')) as { none?: boolean; reason?: string };
      if (meta.none) {
        expect(typeof meta.reason === 'string' && meta.reason.trim().length).toBeTruthy();
        return;
      }
    }
    expect(existsSync(nonBeerHtmlPath(id))).toBe(true);
    const doc = new DOMParser().parseFromString(readFileSync(nonBeerHtmlPath(id), 'utf8'), 'text/html');
    expect(adapter.parseCards(doc)).toEqual([]);
  });

  it('re-badges after the grid is replaced with fresh nodes', async () => {
    const html = readFileSync(fixturePath(id), 'utf8');
    mountFixture(html);
    const stop = startOverlay(document, adapter, sendMatch, { debounceMs: 10 });
    await tick(20);
    expect(document.querySelector('[data-beerbadge]')).not.toBeNull();

    // synthesize AJAX navigation: identical content, fresh badge-less nodes
    mountFixture(html);
    expect(document.querySelector('[data-beerbadge]')).toBeNull();
    await tick(50);
    expect(document.querySelector('[data-beerbadge]')).not.toBeNull();
    stop();
  });
});
