import { pickAdapter } from '../sites/registry';
import { runOverlay, type SendMatch } from './index';
import { observeReRender, type ReRenderOptions } from './rerender';
import { isSeen } from './badge';
import type { SiteAdapter } from '../sites/types';
import type { MatchReply, MatchMessage } from '../background/index';
import type { MatchResult, RawBeer } from '../api/types';

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

/**
 * Run the overlay once, then keep it in sync across in-shop navigation. Returns
 * a disposer that detaches the re-render observer.
 */
export function startOverlay(
  doc: Document,
  adapter: SiteAdapter,
  send: SendMatch,
  opts?: ReRenderOptions,
): () => void {
  const run = () => runOverlay(doc, adapter, send);

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
if (adapter) startOverlay(document, adapter, sendMatch);
