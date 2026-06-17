import type { SiteAdapter } from '../sites/types';
import type { MatchResult, RawBeer } from '../api/types';
import { getCached, setCached } from '../cache/store';
import { normalizeKey } from '../shared/normalize';
import { renderBadge, markSeen } from './badge';

export type SendMatch = (cards: RawBeer[]) => Promise<MatchResult[]>;

export type EnrichOrphans = (
  orphans: { key: string; el: HTMLElement; brewery: string; name: string }[],
) => void;

export async function runOverlay(
  doc: Document,
  adapter: SiteAdapter,
  sendMatch: SendMatch,
  enrich?: EnrichOrphans,
): Promise<void> {
  try {
    if (adapter.waitForGrid) await adapter.waitForGrid(doc);
    const cards = adapter.parseCards(doc);

    const misses: { el: HTMLElement; key: string; raw: RawBeer }[] = [];
    for (const card of cards) {
      const key = normalizeKey(card.brewery, card.name);
      const cached = await getCached(key);
      if (cached) {
        renderBadge(card.el, cached);
        markSeen(card.el);
      } else {
        const raw: RawBeer =
          card.abv !== undefined
            ? { brewery: card.brewery, name: card.name, abv: card.abv }
            : { brewery: card.brewery, name: card.name };
        misses.push({ el: card.el, key, raw });
      }
    }
    if (misses.length === 0) return;

    let results: MatchResult[];
    try {
      results = await sendMatch(misses.map((m) => m.raw));
    } catch {
      return; // network/server error: leave the page untouched, retry next load
    }

    results.forEach((result, i) => {
      const miss = misses[i];
      if (!miss) return;
      renderBadge(miss.el, result);
      markSeen(miss.el);
      void setCached(miss.key, result);
    });

    if (enrich) {
      const orphans = results
        .map((result, i) => ({ result, miss: misses[i] }))
        .filter(
          (x) =>
            x.miss &&
            !x.result.is_drunk &&
            !x.result.drunk_uncertain &&
            (x.result.matched_beer == null || x.result.matched_beer.untappd_id == null),
        )
        .map((x) => ({ key: x.miss!.key, el: x.miss!.el, brewery: x.miss!.raw.brewery, name: x.miss!.raw.name }));
      if (orphans.length) enrich(orphans);
    }
  } catch {
    // Any parsing/rendering failure must never break the host page.
  }
}
