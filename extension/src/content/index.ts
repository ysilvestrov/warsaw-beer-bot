import type { Card, SiteAdapter } from '../sites/types';
import type { MatchResult, RawBeer } from '../api/types';
import { getCached, setCached } from '../cache/store';
import { normalizeKey } from '../shared/normalize';
import { usableAbv } from '../shared/abv';
import { markSeen, renderState, type CardState } from './badge';
import { stateFromMatch } from './card-state';

export type SendMatch = (cards: RawBeer[]) => Promise<MatchResult[]>;
export type CacheMatchResults = (entries: { key: string; result: MatchResult }[]) => Promise<void>;

export type EnrichOrphans = (
  orphans: {
    key: string;
    el: HTMLElement;
    brewery: string;
    name: string;
    // #648: стан, яким картка стане, якщо дошук не дасть нічого кращого. Його рахує той,
    // хто тримає відповідь `/match`; дошук лише повідомляє події й не знає цієї відповіді.
    state: CardState;
    // The /match response is needed to replace this cache entry only after enrichment
    // proves a new Untappd identity (#666).
    result?: MatchResult;
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

type RawMiss = {
  el: HTMLElement;
  key: string;
  raw: RawBeer;
  card: Card;
  abv?: number;
};

const MATCH_CHUNK_SIZE = 200;

// #648 (спека §5.2): `skip` ніс три різні поняття, і всі три закінчувались однаково —
// порожньою карткою. Кінцевий стан пропущеної картки називає причину: деталь товару не
// приїхала (мережа) або розібрати картку не вдалося взагалі.
function skipState(card: Card): CardState {
  return { kind: 'failed', reason: card.skipReason === 'unparsed' ? 'unparsed' : 'network' };
}

function canEnrich(result: MatchResult, card: Card): boolean {
  const matched = result.matched_beer;
  const bidContradicts =
    card.bid !== undefined &&
    matched != null &&
    matched.untappd_id !== null &&
    card.bid !== matched.untappd_id;
  return (
    !result.is_drunk &&
    !result.drunk_uncertain &&
    (matched == null || matched.untappd_id === null || bidContradicts)
  );
}

function freshOrphanPayload(miss: RawMiss, result: MatchResult): Parameters<EnrichOrphans>[0][number] {
  return {
    key: miss.key,
    el: miss.el,
    brewery: miss.raw.brewery,
    name: miss.raw.name,
    state: stateFromMatch(result, { enrichmentPossible: false }),
    result,
    ...(miss.card.bid !== undefined ? { bid: miss.card.bid } : {}),
    ...(miss.card.bid !== undefined && miss.card.bidSlug !== undefined
      ? { bidSlug: miss.card.bidSlug }
      : {}),
    ...(miss.card.brand !== undefined ? { brand: miss.card.brand } : {}),
    // `!== undefined`, never truthiness: 0.0% is a real ABV and the only thing
    // separating some same-brewery twins (#322).
    ...(miss.abv !== undefined ? { abv: miss.abv } : {}),
    ...(miss.card.style !== undefined ? { style: miss.card.style } : {}),
  };
}

async function finalizeMatchPart(
  misses: RawMiss[],
  results: MatchResult[],
  enrich: EnrichOrphans | undefined,
  cacheSetMany: CacheMatchResults,
): Promise<void> {
  // Порядок важить: `enrichmentPossible` має бути відомий ДО малювання, інакше сирота,
  // яка зараз поїде в дошук, на мить блимне як «не знайшли».
  const orphanMisses = enrich
    ? results
      .map((result, i) => ({ result, miss: misses[i] }))
      .filter((x) => x.miss !== undefined && canEnrich(x.result, x.miss.card))
    : [];
  const orphanKeys = new Set(orphanMisses.map((x) => x.miss.key));

  const cacheEntries: { key: string; result: MatchResult }[] = [];
  for (const [i, result] of results.entries()) {
    const miss = misses[i];
    if (!miss) continue;
    renderState(miss.el, stateFromMatch(result, { enrichmentPossible: orphanKeys.has(miss.key) }));
    markSeen(miss.el);
    cacheEntries.push({ key: miss.key, result });
  }
  // Submit one queue item so Refresh cannot clear part of this response and let the
  // remainder arrive afterwards. A cache failure is still non-fatal for enrichment.
  try {
    await cacheSetMany(cacheEntries);
  } catch {
    // Rendering already succeeded; cache storage is an optimisation, not its gate.
  }

  // #648 (рев'ю PR #670): відповідь коротша за запит — не наша справа лагодити, але
  // мовчати про неї не можна: ці картки вже стоять на «працюємо», і без цього циклу
  // крутили б спінер до кінця сторінки, ще й без мітки `markSeen`, тобто під'юджуючи
  // re-render observer щоразу, коли крамниця чіпає DOM. Відповіді для них нема, отже
  // кешувати нічого — це помилка сервера, і так її й називаємо.
  for (const miss of misses.slice(results.length)) {
    renderState(miss.el, { kind: 'failed', reason: 'server' });
    markSeen(miss.el);
  }

  if (enrich && orphanMisses.length) {
    enrich(orphanMisses.map(({ miss, result }) => freshOrphanPayload(miss, result)));
  }
}

export async function runOverlay(
  doc: Document,
  adapter: SiteAdapter,
  sendMatch: SendMatch,
  enrich?: EnrichOrphans,
  cacheSetMany: CacheMatchResults = async (entries) => { await Promise.all(entries.map(({ key, result }) => setCached(key, result))); },
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
    const cachedOrphans: { el: HTMLElement; key: string; card: Card; result: MatchResult }[] = [];
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
        const enrichmentPossible = Boolean(enrich && canEnrich(cached, card));
        renderState(card.el, stateFromMatch(cached, { enrichmentPossible }));
        markSeen(card.el);
        if (enrichmentPossible) cachedOrphans.push({ el: card.el, key, card, result: cached });
      } else {
        misses.push({ el: card.el, key, card });
      }
    }
    if (misses.length === 0 && cachedOrphans.length === 0) return;

    if (!adapter.loadDetailsBeforeCache && adapter.loadCardDetails) {
      await adapter.loadCardDetails([...misses, ...cachedOrphans].map((m) => m.card));
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

    const rawMisses: RawMiss[] = misses
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
    const cachedOrphanPayloads = enrich
      ? cachedOrphans.map(({ key, el, card, result }) => ({
        key, el, brewery: card.brewery, name: card.name,
        state: stateFromMatch(result, { enrichmentPossible: false }), result,
        ...(card.bid !== undefined ? { bid: card.bid } : {}),
        ...(card.bid !== undefined && card.bidSlug !== undefined ? { bidSlug: card.bidSlug } : {}),
        ...(card.brand !== undefined ? { brand: card.brand } : {}),
        ...(usableAbv(card.abv) !== undefined ? { abv: usableAbv(card.abv) } : {}),
        ...(card.style !== undefined ? { style: card.style } : {}),
      }))
      : [];

    for (const m of rawMisses) renderState(m.el, { kind: 'working' });

    for (let i = 0; i < rawMisses.length; i += MATCH_CHUNK_SIZE) {
      const part = rawMisses.slice(i, i + MATCH_CHUNK_SIZE);
      try {
        await finalizeMatchPart(part, await sendMatch(part.map((m) => m.raw)), enrich, cacheSetMany);
      } catch {
        // #648: a failed request must leave a visible terminal state and not re-arm the
        // re-render observer. Later partitions remain eligible for their own request.
        for (const miss of part) {
          renderState(miss.el, { kind: 'failed', reason: 'network' });
          markSeen(miss.el);
        }
      }
    }

    if (enrich && cachedOrphanPayloads.length) enrich(cachedOrphanPayloads);
  } catch {
    // Any parsing/rendering failure must never break the host page.
  }
}
