import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startOverlay, enrichOrphans } from './main';
import { renderState } from './badge';
import { isSeen, type CardState } from './badge';
import { getCached, setCached, setCachedIfMatching } from '../cache/store';
import type { SiteAdapter } from '../sites/types';
import type { MatchResult } from '../api/types';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => { document.body.innerHTML = ''; });

const drunk = (): MatchResult => ({
  raw: { brewery: 'B', name: '' }, matched_beer: null, is_drunk: true, drunk_uncertain: false, user_rating: 4.2, source: null, searched: true,
});

function fakeAdapter(over: Partial<SiteAdapter> = {}): SiteAdapter {
  return {
    id: 'fake',
    hostMatch: () => true,
    parseCards: (root) =>
      Array.from(root.querySelectorAll<HTMLElement>('.card')).map((el) => ({
        el, brewery: 'B', name: el.textContent ?? '',
      })),
    ...over,
  };
}

describe('startOverlay', () => {
  it('does not cascade failed beer retries from an existing non-beer badge', async () => {
    document.body.innerHTML = '<div id="nonbeer"></div><div id="beer"></div>';
    const nonBeer = document.getElementById('nonbeer')!;
    const beer = document.getElementById('beer')!;
    // BeerRepublic returns confirmed cards again, even after they are marked seen.
    const adapter = fakeAdapter({
      parseCards: () => [
        { el: nonBeer, brewery: '', name: '', nonBeer: true, skip: true },
        { el: beer, brewery: 'PINTA', name: 'Hazy Morning' },
      ],
    });
    const sendMatch = vi.fn().mockRejectedValue(new Error('match unavailable'));
    const stop = startOverlay(document, adapter, sendMatch);
    try {
      await tick(0); // first pass finishes and attaches the normal observer
      expect(sendMatch).toHaveBeenCalledTimes(1);
      document.body.appendChild(document.createElement('aside')); // one unrelated mutation
      await tick(1400); // several default 250ms debounce intervals

      // #648: the failure badge is itself a DOM write, so a failed card left unseen would
      // re-arm the pass that drew it — one /match per debounce interval, forever. The pass
      // marks it seen instead; a real grid re-render still retries it on fresh nodes.
      expect(sendMatch).toHaveBeenCalledTimes(1);
      expect(nonBeer.querySelectorAll('[data-beerbadge]')).toHaveLength(1);
      expect(
        nonBeer.querySelector('[data-beerbadge] [data-icon]')?.getAttribute('data-icon'),
      ).toBe('cross');
      expect(
        beer.querySelector('[data-beerbadge] [data-icon]')?.getAttribute('data-icon'),
      ).toBe('warn');
    } finally {
      stop();
    }
  });

  it('badges the first pass and re-badges after the grid is replaced', async () => {
    document.body.innerHTML = '<div class="grid"><div class="card">One</div></div>';
    const sendMatch = vi.fn(async () => [drunk()]);

    const stop = startOverlay(document, fakeAdapter(), sendMatch, { debounceMs: 10 });
    await tick(0); // let the first async pass resolve
    expect(document.querySelector('.card [data-beerbadge]')).not.toBeNull();

    // simulate AJAX navigation: replace the grid with fresh, unmarked nodes
    document.body.innerHTML = '<div class="grid"><div class="card">One</div></div>';
    const fresh = document.querySelector('.card') as HTMLElement;
    expect(isSeen(fresh)).toBe(false);
    await tick(40);
    // the observer re-ran and re-processed the fresh node (badge from cache)
    expect(isSeen(fresh)).toBe(true);
    expect(fresh.querySelector('[data-beerbadge]')).not.toBeNull();
    stop();
  });

  it('attaches the observer even when reRenderContainerSelector is absent', async () => {
    document.body.innerHTML = '<div class="card">One</div>';
    const sendMatch = vi.fn(async () => [drunk()]);
    const stop = startOverlay(document, fakeAdapter(), sendMatch, { debounceMs: 10 });
    await tick(0);
    document.body.innerHTML = '<div class="card">One</div>';
    const fresh = document.querySelector('.card') as HTMLElement;
    await tick(40);
    expect(isSeen(fresh)).toBe(true); // re-ran without a selector
    stop();
  });
});

// The two mappings inside enrichOrphans are the last hops before the service worker, and
// they are plain field copies — TypeScript cannot catch a *dropped* optional field, so
// omitting `bid` here would compile and pass every other test while shipping the #384
// override dead. This drives the real runEnrichment against a stubbed service worker.
describe('enrichOrphans relays shop facts to the service worker', () => {
  type Msg = Record<string, unknown> & { type: string };

  // #648: runOverlay hands each orphan the state it falls back to if enrichment finds
  // nothing better. These tests are about the fact-relaying hops, so any valid state does.
  const fallbackState = (brewery: string, name: string): CardState =>
    ({ kind: 'missing', brewery, name, orphan: true });

  function stubServiceWorker(result?: unknown): Msg[] {
    const sent: Msg[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((msg: Msg, cb: (r: unknown) => void) => {
        sent.push(msg);
        if (msg.type === 'enrich:candidates') {
          const beers = msg.beers as { brewery: string; name: string }[];
          cb({
            candidates: beers.map((b) => ({
              brewery: b.brewery, name: b.name, eligible: true,
              algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'q', hitsPerPage: 5 },
            })),
          });
        } else if (msg.type === 'enrich:fetch') {
          cb({ algolia: { hits: [{ bid: 6648348 }] } });
        } else if (msg.type === 'enrich:result') {
          cb({ result: result ?? { status: 'matched', untappd_id: 6648348, rating_global: 3.9 } });
        } else if (msg.type === 'cache:set-if-matching') {
          const m = msg as Msg & { key: string; expected: MatchResult; result: MatchResult };
          void setCachedIfMatching(m.key, m.expected, m.result).then((written) => cb({ written }));
        } else cb(undefined);
        return undefined;
      }) as never,
    );
    return sent;
  }

  async function until(pred: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !pred(); i++) await tick(0);
  }

  it('carries bid, bidSlug, abv and style through both mappings', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{
      key: 'k0', el, brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      state: fallbackState('Mad Brew', 'Tomatol Bulgogi'),
      bid: 6648348, bidSlug: 'mad-brew-tomatol-bulgogi', abv: 5.5, style: 'IPA',
    }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));

    // mapping 1: orphan -> OrphanBeer, observed via the /enrich/candidates payload
    const candidates = sent.find((m) => m.type === 'enrich:candidates')!;
    expect((candidates.beers as unknown[])[0]).toEqual({
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi', bid: 6648348, abv: 5.5, style: 'IPA',
    });

    // mapping 2: OrphanFacts -> the enrich:result message
    expect(sent.find((m) => m.type === 'enrich:result')).toMatchObject({
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, bidSlug: 'mad-brew-tomatol-bulgogi', brand: 'Mad Brew',
      abv: 5.5, style: 'IPA',
    });
  });

  it('preserves an explicit placeholder brand separately from brewery (#307)', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{
      key: 'k0', el, brewery: 'Trappistes', name: 'Rochefort 8 (2025)',
      state: fallbackState('Trappistes', 'Rochefort 8 (2025)'),
      brand: 'Імпортне пиво', bid: 6134078,
      bidSlug: 'abbaye-notre-dame-de-saint-remy-trappistes-rochefort-8-2025',
    }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));

    expect(sent.find((m) => m.type === 'enrich:result')).toMatchObject({
      brewery: 'Trappistes', name: 'Rochefort 8 (2025)',
      brand: 'Імпортне пиво', bid: 6134078,
    });
  });

  // #391: the executed ladder rung must survive the content-script → service-worker hop.
  it('forwards the executed query into the enrich:result message', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N') }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));

    const result = sent.find((m) => m.type === 'enrich:result')!;
    // stubServiceWorker's /enrich/candidates answer offers a single rung with query: 'q' —
    // assert the exact rung that was executed, not merely that *some* string arrived.
    expect(result.query).toBe('q');
  });

  it('omits every optional fact when the shop published none', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N') }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));

    expect((sent.find((m) => m.type === 'enrich:candidates')!.beers as unknown[])[0])
      .toEqual({ brewery: 'B', name: 'N' });
    const result = sent.find((m) => m.type === 'enrich:result')!;
    for (const k of ['bid', 'bidSlug', 'brand', 'abv', 'style']) {
      expect(Object.keys(result)).not.toContain(k);
    }
  });

  // #648: enrich.ts reports events and main.ts is the ONE place that turns them into a
  // badge. The translation is a field-by-field copy, so a dropped rating or a wrong state
  // kind compiles and passes every enrich.test.ts case — these drive the real hop.
  it('turns a found event into the rated star badge', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N') }]);
    await until(() => el.querySelector('[data-beerbadge] [data-icon="star"]') !== null);

    const badge = el.querySelector('[data-beerbadge]')!;
    expect(badge.textContent).toContain('3.9');
    expect(badge.getAttribute('aria-label')).toBe('Ти це не пив. Глобальна оцінка 3,9');
  });

  it('replaces a cached orphan when enrichment finds its Untappd id', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker();
    const result: MatchResult = {
      raw: { brewery: 'B', name: 'N' },
      matched_beer: { id: 4, brewery: 'B', name: 'N', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
    };
    await setCached('k0', result);
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N'), result }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));
    await tick(0);

    expect(await getCached('k0')).toMatchObject({
      matched_beer: { id: 4, untappd_id: 6648348, rating_global: 3.9 },
    });
  });

  it('does not overwrite a refreshed match when an older enrichment finishes', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const orphan: MatchResult = {
      raw: { brewery: 'B', name: 'N' },
      matched_beer: { id: 4, brewery: 'B', name: 'N', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
    };
    const refreshed: MatchResult = {
      ...orphan,
      matched_beer: { id: 9, brewery: 'B', name: 'Newer result', rating_global: 4.6, untappd_id: 999 },
      is_drunk: true,
      user_rating: 4.25,
    };
    await setCached('k0', orphan);
    let replyToSearch: (() => void) | undefined;
    const sent: string[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type: string }, cb: (reply: unknown) => void) => {
        sent.push(msg.type);
        if (msg.type === 'enrich:candidates') {
          cb({ candidates: [{ brewery: 'B', name: 'N', eligible: true,
            algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'q', hitsPerPage: 5 } }] });
        } else if (msg.type === 'enrich:fetch') {
          replyToSearch = () => cb({ algolia: { hits: [{ bid: 6648348 }] } });
        } else if (msg.type === 'enrich:result') {
          cb({ result: { status: 'matched', untappd_id: 6648348, rating_global: 3.9 } });
        } else if (msg.type === 'cache:set-if-matching') {
          const m = msg as unknown as { key: string; expected: MatchResult; result: MatchResult };
          void setCachedIfMatching(m.key, m.expected, m.result).then((written) => cb({ written }));
        } else cb(undefined);
        return undefined;
      }) as never,
    );
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N'), result: orphan }]);
    await until(() => replyToSearch !== undefined);
    await setCached('k0', refreshed);
    replyToSearch!();
    await until(() => sent.includes('enrich:result'));
    await tick(0);

    expect(await getCached('k0')).toEqual(refreshed);
  });

  it('keeps a cached orphan after Untappd blocks the enrichment', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker({ status: 'blocked' });
    const result: MatchResult = {
      raw: { brewery: 'B', name: 'N' },
      matched_beer: { id: 4, brewery: 'B', name: 'N', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
    };
    await setCached('k0', result);
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N'), result }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));
    await tick(0);

    expect(await getCached('k0')).toEqual(result);
  });

  it('settles a fruitless search back onto the state /match proved', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker({ status: 'not_found' });
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N') }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));
    await until(() => el.querySelector('[data-beerbadge] [data-icon="search"]') !== null);

    // The fallback carried `orphan: true`, so the label must be the catalogue one — proving
    // the /match state was restored rather than a fresh generic "missing" invented here.
    expect(el.querySelector('[data-beerbadge]')!.getAttribute('aria-label'))
      .toBe('Пиво є в каталозі, але сторінки на Untappd нема. Клік відкриє пошук');
  });

  it('shows a blocked search as an error, not as a verdict', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker({ status: 'blocked' });
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N') }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));
    await until(() => el.querySelector('[data-beerbadge] [data-icon="warn"]') !== null);

    expect(el.querySelector('[data-beerbadge]')!.getAttribute('aria-label'))
      .toBe('Не вдалося перевірити: Untappd не відповів');
  });

  it('does nothing at all while the enrich opt-in is off', async () => {
    await chrome.storage.local.set({ enrichEnabled: false, token: 't' });
    const sent = stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallbackState('B', 'N'), bid: 6648348 }]);
    await until(() => sent.length > 0);

    expect(sent).toEqual([]);
  });
});

// PR #670 review. Both findings are the same shape: runOverlay drew these cards «в черзі»
// precisely BECAUSE this callback exists, so anything that returns without emitting leaves
// them spinning for the life of the page.
describe('enrichOrphans resolves the cards it was handed (#670 review)', () => {
  const fallback = (brewery: string, name: string): CardState =>
    ({ kind: 'missing', brewery, name, orphan: true });

  const iconOf = (el: HTMLElement): string | null =>
    el.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null;

  const card = (): HTMLElement => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  };

  async function until(pred: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !pred(); i++) await tick(0);
  }

  it('falls the cards back to their /match state when enrichment is switched off', async () => {
    await chrome.storage.local.set({ enrichEnabled: false, token: 't' });
    const el = card();
    renderState(el, { kind: 'queued' });

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', state: fallback('B', 'N') }]);
    await until(() => iconOf(el) === 'search');

    expect(iconOf(el)).toBe('search');
  });

  it('redraws every duplicate card that shares a normalized key, not just the last one', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type: string; beers?: { brewery: string; name: string }[] }, cb: (r: unknown) => void) => {
        if (msg.type === 'enrich:candidates') {
          cb({
            candidates: (msg.beers ?? []).map((b) => ({
              brewery: b.brewery, name: b.name, eligible: true,
              algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'q', hitsPerPage: 5 },
            })),
          });
        } else if (msg.type === 'enrich:fetch') cb({ algolia: { hits: [{ bid: 6648348 }] } });
        else if (msg.type === 'enrich:result') {
          cb({ result: { status: 'matched', untappd_id: 6648348, rating_global: 3.9 } });
        } else cb(undefined);
        return undefined;
      }) as never,
    );

    const first = card();
    const second = card();
    renderState(first, { kind: 'queued' });
    renderState(second, { kind: 'queued' });

    enrichOrphans([
      { key: 'same', el: first, brewery: 'B', name: 'N', state: fallback('B', 'N') },
      { key: 'same', el: second, brewery: 'B', name: 'N', state: fallback('B', 'N') },
    ]);
    await until(() => iconOf(first) === 'star' && iconOf(second) === 'star');

    expect(iconOf(first)).toBe('star');
    expect(iconOf(second)).toBe('star');
  });

  // Round 2: two products can share a normalized brewery+name and still publish
  // different Untappd ids. The enrichment path's identity IS that pair, so it cannot
  // hold both claims — and painting the first card's answer onto the second would show
  // a beer the shop never linked there.
  it('does not lend one card\'s answer to a same-key card that publishes a different bid', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const asked: { bid?: number }[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type: string; beers?: { brewery: string; name: string; bid?: number }[] },
        cb: (r: unknown) => void) => {
        if (msg.type === 'enrich:candidates') {
          asked.push(...(msg.beers ?? []));
          cb({
            candidates: (msg.beers ?? []).map((b) => ({
              brewery: b.brewery, name: b.name, eligible: true,
              algolia: { appId: 'APP', searchKey: 'KEY', indexName: 'beer', query: 'q', hitsPerPage: 5 },
            })),
          });
        } else if (msg.type === 'enrich:fetch') cb({ algolia: { hits: [{ bid: 111 }] } });
        else if (msg.type === 'enrich:result') {
          cb({ result: { status: 'matched', untappd_id: 111, rating_global: 3.9 } });
        } else cb(undefined);
        return undefined;
      }) as never,
    );

    const first = card();
    const second = card();
    renderState(first, { kind: 'queued' });
    renderState(second, { kind: 'queued' });

    enrichOrphans([
      { key: 'same', el: first, brewery: 'B', name: 'N', state: fallback('B', 'N'), bid: 111 },
      { key: 'same', el: second, brewery: 'B', name: 'N', state: fallback('B', 'N'), bid: 222 },
    ]);
    await until(() => iconOf(first) === 'star');

    expect(iconOf(first)).toBe('star');
    // The disagreeing sibling keeps what /match proved for it — a search glyph, not a
    // star pointing at a bid its own page never published.
    expect(iconOf(second)).toBe('search');
    expect(asked).toHaveLength(1);
  });
});
