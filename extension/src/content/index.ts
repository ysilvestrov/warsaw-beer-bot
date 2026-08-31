import type { Card, SiteAdapter } from '../sites/types';
import type { MatchResult, RawBeer } from '../api/types';
import { getCached, setCached } from '../cache/store';
import { normalizeKey } from '../shared/normalize';
import { usableAbv } from '../shared/abv';
import { renderBadge, markSeen } from './badge';

export type SendMatch = (cards: RawBeer[]) => Promise<MatchResult[]>;

export type EnrichOrphans = (
  orphans: {
    key: string;
    el: HTMLElement;
    brewery: string;
    name: string;
    // #369: shop-published facts, relayed to /enrich/* so the matcher stops
    // running blind. Omitted when the adapter did not publish them.
    abv?: number;
    style?: string;
    // #384: the Untappd identity the shop publishes on its own product page.
    bid?: number;
    bidSlug?: string;
  }[],
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

    const misses: { el: HTMLElement; key: string; card: Card }[] = [];
    for (const card of cards) {
      const key = normalizeKey(card.brewery, card.name);
      const cached = await getCached(key);
      if (cached?.matched_beer != null) {
        renderBadge(card.el, cached);
        markSeen(card.el);
      } else {
        misses.push({ el: card.el, key, card });
      }
    }
    if (misses.length === 0) return;

    if (adapter.loadCardDetails) await adapter.loadCardDetails(misses.map((m) => m.card));

    // `abv` is sanitized once, here, where a card's shop-published value first enters a
    // payload — that covers every adapter and both the /match and /enrich/* paths (#369).
    // `card` is kept alongside `raw` because /match carries only abv, while the enrich
    // payload also needs the shop style.
    const rawMisses: { el: HTMLElement; key: string; raw: RawBeer; card: Card; abv?: number }[] = misses
      .filter(({ card }) => !card.skip)
      // #384: `key` is carried over from the lookup, never recomputed. loadCardDetails may
      // have overridden the card's brewery by now, and a write key derived from the new
      // identity would never be read back — making every hydrated card a permanent cache
      // miss, and freezing the enrichment window on the same first cards forever.
      .map(({ el, key, card }) => {
        const abv = usableAbv(card.abv);
        return {
          el,
          key,
          raw: abv !== undefined
            ? { brewery: card.brewery, name: card.name, abv }
            : { brewery: card.brewery, name: card.name },
          card,
          ...(abv !== undefined ? { abv } : {}),
        };
      });
    if (rawMisses.length === 0) return;

    let results: MatchResult[];
    try {
      results = await sendMatch(rawMisses.map((m) => m.raw));
    } catch {
      return; // network/server error: leave the page untouched, retry next load
    }

    results.forEach((result, i) => {
      const miss = rawMisses[i];
      if (!miss) return;
      renderBadge(miss.el, result);
      markSeen(miss.el);
      void setCached(miss.key, result);
    });

    if (enrich) {
      const orphans = results
        .map((result, i) => ({ result, miss: rawMisses[i] }))
        .filter((x) => {
          if (!x.miss) return false;
          // #384: a card the shop links to a *different* Untappd id than the one we
          // stored is the only route to the server's repair path — it comes back from
          // /match matched, so the orphan test below never sees it.
          const matched = x.result.matched_beer;
          const bidContradicts =
            x.miss.card.bid !== undefined &&
            matched != null &&
            matched.untappd_id !== null &&
            x.miss.card.bid !== matched.untappd_id;
          // The drunk exclusions gate BOTH branches, deliberately: a check-in means the
          // user engaged with this beer, and re-linking underneath them is a bigger
          // surprise than leaving one wrong badge. Revisit if that proves too cautious.
          return (
            !x.result.is_drunk &&
            !x.result.drunk_uncertain &&
            (matched == null || matched.untappd_id == null || bidContradicts)
          );
        })
        .map((x) => ({
          key: x.miss!.key,
          el: x.miss!.el,
          brewery: x.miss!.raw.brewery,
          name: x.miss!.raw.name,
          ...(x.miss!.card.bid !== undefined ? { bid: x.miss!.card.bid } : {}),
          ...(x.miss!.card.bid !== undefined && x.miss!.card.bidSlug !== undefined
            ? { bidSlug: x.miss!.card.bidSlug }
            : {}),
          // `!== undefined`, never truthiness: 0.0% is a real ABV and the only thing
          // separating some same-brewery twins (#322).
          ...(x.miss!.abv !== undefined ? { abv: x.miss!.abv } : {}),
          ...(x.miss!.card.style !== undefined ? { style: x.miss!.card.style } : {}),
        }));
      if (orphans.length) enrich(orphans);
    }
  } catch {
    // Any parsing/rendering failure must never break the host page.
  }
}
