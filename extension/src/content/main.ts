import { pickAdapter } from '../sites/registry';
import { runOverlay, type SendMatch, type EnrichOrphans } from './index';
import { observeReRender, type ReRenderOptions } from './rerender';
import { isSeen, setSearching, setEnriched, setOrphan } from './badge';
import { runEnrichment, type OrphanBeer } from './enrich';
import { trimSearchHtml } from './untappd-trim';
import { getSettings } from '../shared/config';
import type { SiteAdapter } from '../sites/types';
import type { MatchReply, MatchMessage } from '../background/index';
import type { MatchResult, RawBeer, EnrichCandidate, EnrichResult } from '../api/types';

const sendMatch: SendMatch = (cards: RawBeer[]) =>
  new Promise<MatchResult[]>((resolve, reject) => {
    const message: MatchMessage = { type: 'match', cards };
    chrome.runtime.sendMessage(message, (reply: MatchReply | undefined) => {
      if (chrome.runtime.lastError || !reply) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'no reply'));
        return;
      }
      if (reply.type === 'match:ok') resolve(reply.results);
      else reject(new Error(reply.code));
    });
  });

function sendBg<T>(message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (r: T) => resolve(r)));
}

// Bridges the page's orphan beers into the enrichment queue: gated on the opt-in setting,
// relays Untappd fetch + /enrich/* calls through the service worker, and drives badge states.
const enrichOrphans: EnrichOrphans = (orphans) => {
  void (async () => {
    const { enrichEnabled } = await getSettings();
    if (!enrichEnabled) return;
    const elByKey = new Map(orphans.map((o) => [o.key, o.el]));
    const beers: OrphanBeer[] = orphans.map((o) => ({ key: o.key, brewery: o.brewery, name: o.name }));
    await runEnrichment(beers, {
      getCandidates: async (bs) =>
        (await sendBg<{ candidates: EnrichCandidate[] }>({ type: 'enrich:candidates', beers: bs }))?.candidates ?? [],
      fetchSearch: async (url) =>
        (await sendBg<{ html: string | null }>({ type: 'enrich:fetch', url }))?.html ?? null,
      trim: trimSearchHtml,
      submitResult: async (brewery, name, html) =>
        (await sendBg<{ result: EnrichResult | null }>({ type: 'enrich:result', brewery, name, html }))?.result ??
        { status: 'transient' },
      setSearching: (key) => { const el = elByKey.get(key); if (el) setSearching(el); },
      setEnriched: (key, id, r) => { const el = elByKey.get(key); if (el) setEnriched(el, id, r); },
      setOrphan: (key) => { const el = elByKey.get(key); if (el) setOrphan(el); },
    });
  })();
};

/**
 * Run the overlay once, then keep it in sync across in-shop navigation. Returns
 * a disposer that detaches the re-render observer.
 */
export function startOverlay(
  doc: Document,
  adapter: SiteAdapter,
  send: SendMatch,
  opts?: ReRenderOptions,
  enrich?: EnrichOrphans,
): () => void {
  const run = () => runOverlay(doc, adapter, send, enrich);

  const hasUnprocessed = () => {
    const scope = adapter.reRenderContainerSelector
      ? doc.querySelector(adapter.reRenderContainerSelector) ?? doc
      : doc;
    return adapter.parseCards(scope).some((card) => !isSeen(card.el));
  };

  let dispose: () => void = () => {};
  // First pass awaits waitForGrid, so the grid exists before we observe.
  void run().then(() => {
    dispose = observeReRender(doc, hasUnprocessed, run, opts);
  });

  return () => dispose();
}

const adapter = pickAdapter(new URL(window.location.href));
if (adapter) startOverlay(document, adapter, sendMatch, undefined, enrichOrphans);
