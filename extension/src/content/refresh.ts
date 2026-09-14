import { normalizeKey } from '../shared/normalize';
import { resetCard } from './badge';
import type { SiteAdapter } from '../sites/types';

// Resets every parsed card on the page (removes badge + seen marker) and returns
// the cache keys for those cards, so the caller can drop them from the cache before
// re-running the overlay to fetch fresh results. Site-independent keys mean this is
// the "refresh the open page" primitive behind the popup's per-site button.
export async function refreshCards(doc: Document, adapter: SiteAdapter): Promise<string[]> {
  const keys: string[] = [];
  const cards = adapter.parseCards(doc);
  if (adapter.loadDetailsBeforeCache && adapter.loadCardDetails) {
    await adapter.loadCardDetails(cards);
  }
  for (const card of cards) {
    if (!card.nonBeer) keys.push(normalizeKey(card.brewery, card.name));
    resetCard(card.el);
  }
  return keys;
}
