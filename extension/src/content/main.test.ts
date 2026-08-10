import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startOverlay, enrichOrphans } from './main';
import { isSeen } from './badge';
import type { SiteAdapter } from '../sites/types';
import type { MatchResult } from '../api/types';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => { document.body.innerHTML = ''; });

const drunk = (): MatchResult => ({
  raw: { brewery: 'B', name: '' }, matched_beer: null, is_drunk: true, drunk_uncertain: false, user_rating: 4.2,
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

  function stubServiceWorker(): Msg[] {
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
          cb({ result: { status: 'matched', untappd_id: 6648348, rating_global: 3.9 } });
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

  // #391: the executed ladder rung must survive the content-script → service-worker hop.
  it('forwards the executed query into the enrich:result message', async () => {
    await chrome.storage.local.set({ enrichEnabled: true, token: 't' });
    const sent = stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N' }]);
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

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N' }]);
    await until(() => sent.some((m) => m.type === 'enrich:result'));

    expect((sent.find((m) => m.type === 'enrich:candidates')!.beers as unknown[])[0])
      .toEqual({ brewery: 'B', name: 'N' });
    const result = sent.find((m) => m.type === 'enrich:result')!;
    for (const k of ['bid', 'bidSlug', 'brand', 'abv', 'style']) {
      expect(Object.keys(result)).not.toContain(k);
    }
  });

  it('does nothing at all while the enrich opt-in is off', async () => {
    await chrome.storage.local.set({ enrichEnabled: false, token: 't' });
    const sent = stubServiceWorker();
    const el = document.createElement('div');
    document.body.appendChild(el);

    enrichOrphans([{ key: 'k0', el, brewery: 'B', name: 'N', bid: 6648348 }]);
    await until(() => sent.length > 0);

    expect(sent).toEqual([]);
  });
});
