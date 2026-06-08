import { pickAdapter } from '../sites/registry';
import { runOverlay, type SendMatch } from './index';
import { observeReRender } from './rerender';
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

const adapter = pickAdapter(new URL(window.location.href));
if (adapter) {
  const run = () => runOverlay(document, adapter, sendMatch);
  // First pass awaits waitForGrid, so by the time it resolves the SPA grid
  // container exists — only then attach the re-render observer.
  void run().then(() => {
    if (adapter.reRenderContainerSelector) {
      observeReRender(document, adapter.reRenderContainerSelector, run);
    }
  });
}
