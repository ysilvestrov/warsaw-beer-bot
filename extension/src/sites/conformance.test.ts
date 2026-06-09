import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADAPTERS } from './registry';
import { startOverlay } from '../content/main';
import type { MatchResult, RawBeer } from '../api/types';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixturePath = (id: string) => resolve(__dirname, `../../tests/fixtures/${id}.html`);

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
      user_rating: i === 0 ? 4 : null,
    })),
  );

beforeEach(() => { document.body.innerHTML = ''; });

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
