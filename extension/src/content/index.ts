import type { Card, SiteAdapter } from '../sites/types';
import type { MatchResult, RawBeer } from '../api/types';
import { getCached, setCached } from '../cache/store';
import { normalizeKey } from '../shared/normalize';
import { usableAbv } from '../shared/abv';
import { markSeen, renderState, type CardState } from './badge';
import { stateFromMatch } from './card-state';

export type SendMatch = (cards: RawBeer[]) => Promise<MatchResult[]>;

export type EnrichOrphans = (
  orphans: {
    key: string;
    el: HTMLElement;
    brewery: string;
    name: string;
    // #648: стан, яким картка стане, якщо дошук не дасть нічого кращого. Його рахує той,
    // хто тримає відповідь `/match`; дошук лише повідомляє події й не знає цієї відповіді.
    state: CardState;
    // #369: shop-published facts, relayed to /enrich/* so the matcher stops
    // running blind. Omitted when the adapter did not publish them.
    abv?: number;
    style?: string;
    // #384: the Untappd identity the shop publishes on its own product page.
    bid?: number;
    bidSlug?: string;
    brand?: string;
  }[],
) => void;

// #648 (спека §5.2): `skip` ніс три різні поняття, і всі три закінчувались однаково —
// порожньою карткою. Кінцевий стан пропущеної картки називає причину: деталь товару не
// приїхала (мережа) або розібрати картку не вдалося взагалі.
function skipState(card: Card): CardState {
  return { kind: 'failed', reason: card.skipReason === 'unparsed' ? 'unparsed' : 'network' };
}

export async function runOverlay(
  doc: Document,
  adapter: SiteAdapter,
  sendMatch: SendMatch,
  enrich?: EnrichOrphans,
): Promise<void> {
  try {
    if (adapter.waitForGrid) await adapter.waitForGrid(doc);
    const cards = adapter.parseCards(doc);
    const keyByCard = new Map<Card, string>();
    for (const card of cards) {
      if (!card.nonBeer) keyByCard.set(card, normalizeKey(card.brewery, card.name));
    }

    // #648: бейдж з'являється в ту мить, коли картку взято в роботу, а не коли прийшла
    // відповідь. До цієї зміни порожня картка означала п'ятнадцять різних речей — зокрема
    // два протилежні: «зараз буде» і «більше нічого не буде».
    for (const card of cards) {
      if (card.nonBeer) {
        renderState(card.el, { kind: 'nonBeer' });
        markSeen(card.el);
        continue;
      }
      // Деталь товару вже летить — це не черга, це робота (спека §5.2).
      renderState(card.el, card.skipReason === 'pending-detail'
        ? { kind: 'working' }
        : { kind: 'queued' });
    }

    if (adapter.loadDetailsBeforeCache && adapter.loadCardDetails) {
      await adapter.loadCardDetails(cards);
    }

    const misses: { el: HTMLElement; key: string; card: Card }[] = [];
    for (const card of cards) {
      // Repeated deliberately: on the loadDetailsBeforeCache path the shop's own verdict
      // arrives only with the product detail, so the pass above saw a plain queued card.
      if (card.nonBeer) {
        renderState(card.el, { kind: 'nonBeer' });
        markSeen(card.el);
        continue;
      }
      // `card.skip`, not `card.skipReason`: the reason survives a successful hydration,
      // the flag does not. A card whose product page arrived clears `skip` and goes on
      // to /match like any other.
      if (adapter.loadDetailsBeforeCache && card.skip) {
        renderState(card.el, skipState(card));
        markSeen(card.el);
        continue;
      }

      const key = keyByCard.get(card);
      if (key === undefined) continue;
      const cached = await getCached(key);
      if (cached?.matched_beer != null) {
        // `enrichmentPossible: false` — кешований результат кінцевий для цього проходу:
        // картка не потрапляє в `misses`, а черга дошуку будується лише з них (#666).
        renderState(card.el, stateFromMatch(cached, { enrichmentPossible: false }));
        markSeen(card.el);
      } else {
        misses.push({ el: card.el, key, card });
      }
    }
    if (misses.length === 0) return;

    if (!adapter.loadDetailsBeforeCache && adapter.loadCardDetails) {
      await adapter.loadCardDetails(misses.map((m) => m.card));
    }

    // `abv` is sanitized once, here, where a card's shop-published value first enters a
    // payload — that covers every adapter and both the /match and /enrich/* paths (#369).
    // `card` is kept alongside `raw` because /match carries only abv, while the enrich
    // payload also needs the shop style.
    // The other hydration path (funkyshop): the card was already a miss when the detail
    // page failed to name its brewery. Nothing more will happen to it, so it says so.
    for (const m of misses) {
      if (!m.card.skip) continue;
      renderState(m.el, skipState(m.card));
      markSeen(m.el);
    }

    const rawMisses: { el: HTMLElement; key: string; raw: RawBeer; card: Card; abv?: number }[] = misses
      .filter(({ card }) => !card.skip)
      // #384: `key` is carried over from the lookup, never recomputed. loadCardDetails may
      // have overridden the card's brewery by now, and a write key derived from the new
      // identity would never be read back — making every hydrated card a permanent cache
      // miss, and freezing the enrichment window on the same first cards forever.
      .map(({ el, key, card }) => {
        const abv = usableAbv(card.abv);
        // #633: bid and brand travel together or not at all — without a bid the brand proves
        // nothing to the server, and a bid with no brand has no brewery evidence behind it
        // (it would still reach the "name and bid agree" rule, so the pair is kept whole here).
        // The id is sanitised where a shop-published value first enters a payload, the same
        // rule `abv` follows: one malformed id would fail schema validation for the whole
        // page's batch, and every uncached card on it would go unbadged (AI review, PR #654).
        const bid = card.bid;
        const brand = card.brand?.trim();
        const published = bid !== undefined && Number.isSafeInteger(bid) && bid > 0 && brand
          ? { bid, brand }
          : {};
        return {
          el,
          key,
          raw: abv !== undefined
            ? { brewery: card.brewery, name: card.name, abv, ...published }
            : { brewery: card.brewery, name: card.name, ...published },
          card,
          ...(abv !== undefined ? { abv } : {}),
        };
      });
    if (rawMisses.length === 0) return;

    for (const m of rawMisses) renderState(m.el, { kind: 'working' });

    let results: MatchResult[];
    try {
      results = await sendMatch(rawMisses.map((m) => m.raw));
    } catch {
      // #648: a silent `return` here left every uncached card on the page blank, which is
      // also what "still loading" looks like — the user could not tell a dead request from
      // a slow one.
      //
      // Seen, not left open: this write is itself a DOM mutation, and the re-render
      // observer re-runs whenever a parsed card is unseen. Leaving a failed card unseen
      // makes the failure badge re-arm the pass that drew it — one /match per debounce
      // interval, forever, against a server that is already failing. The old code was
      // safe from this only by accident: a failed pass wrote nothing at all. The real
      // retry routes are untouched — a shop re-render brings fresh unseen nodes, and the
      // popup's refresh calls resetCard.
      for (const m of rawMisses) {
        renderState(m.el, { kind: 'failed', reason: 'network' });
        markSeen(m.el);
      }
      return;
    }

    // Порядок важить: `enrichmentPossible` має бути відомий ДО малювання, інакше сирота,
    // яка зараз поїде в дошук, на мить блимне як «не знайшли».
    const orphanMisses = enrich
      ? results
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
      : [];
    const orphanKeys = new Set(orphanMisses.map((x) => x.miss!.key));

    results.forEach((result, i) => {
      const miss = rawMisses[i];
      if (!miss) return;
      renderState(miss.el, stateFromMatch(result, { enrichmentPossible: orphanKeys.has(miss.key) }));
      markSeen(miss.el);
      void setCached(miss.key, result);
    });

    if (enrich) {
      const orphans = orphanMisses
        .map((x) => ({
          key: x.miss!.key,
          el: x.miss!.el,
          brewery: x.miss!.raw.brewery,
          name: x.miss!.raw.name,
          // Стан, яким картка стане, якщо дошук нічого не знайде: він уже врахував, що
          // після дошуку черги більше не буде.
          state: stateFromMatch(x.result, { enrichmentPossible: false }),
          ...(x.miss!.card.bid !== undefined ? { bid: x.miss!.card.bid } : {}),
          ...(x.miss!.card.bid !== undefined && x.miss!.card.bidSlug !== undefined
            ? { bidSlug: x.miss!.card.bidSlug }
            : {}),
          ...(x.miss!.card.brand !== undefined ? { brand: x.miss!.card.brand } : {}),
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
