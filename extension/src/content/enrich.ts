import type { AlgoliaQuery, AlgoliaResponse, EnrichCandidate, EnrichResult } from '../api/types';
import { usableAbv } from '../shared/abv';

export const MAX_SEARCHES_PER_PAGE = 20;
export const DEFAULT_DELAY_MS = 4000;

export interface OrphanBeer {
  key: string;
  brewery: string;
  name: string;
  /** Shop-published ABV. 0 is a real value — never test it for truthiness (#369/#322). */
  abv?: number;
  /** Shop-published style, persisted server-side for orphan rows (#369). */
  style?: string;
  /** #384: the Untappd beer id the shop publishes on its own product page. */
  bid?: number;
  /** #384: the slug published alongside `bid`; a server-side integrity signal. */
  bidSlug?: string;
  /** Product-page brand; separate when a shop exposes a non-brewery placeholder. */
  brand?: string;
}

/** The shop-published facts that travel with a beer to /enrich/* (#369). */
export interface OrphanFacts {
  abv?: number;
  style?: string;
  /** #384: shop-published Untappd identity, and the brand the server verifies it against. */
  bid?: number;
  bidSlug?: string;
  brand?: string;
}

/**
 * #648: дошук повідомляє, ЩО сталося, і не вирішує, як це виглядає. Перекладає події в
 * бейджі той, хто тримає початкову відповідь `/match` (`content/main.ts`), бо лише він
 * знає, до якого стану картка відкотиться, якщо дошук нічого не знайде.
 *
 * `settled` і `deferred` — різні твердження, і плутати їх не можна: `settled` каже
 * «дошук сказав останнє слово», `deferred` — «ми не дивилися й цього разу вже не
 * подивимось» (спека §6).
 */
export type EnrichEvent =
  | { kind: 'searching' }
  | { kind: 'found'; untappdId: number; ratingGlobal: number | null }
  | { kind: 'settled' }
  | { kind: 'deferred' }
  | { kind: 'failed'; reason: 'blocked' | 'network' };

export interface EnrichDeps {
  getCandidates: (
    beers: ({ brewery: string; name: string } & OrphanFacts)[],
  ) => Promise<EnrichCandidate[]>;
  fetchSearch: (algolia: AlgoliaQuery) => Promise<AlgoliaResponse | null>;
  submitResult: (
    brewery: string,
    name: string,
    algolia: AlgoliaResponse,
    facts: OrphanFacts | undefined,
    /** #391: the ladder rung that produced `algolia` — the server records it as search_url. */
    query: string,
  ) => Promise<EnrichResult>;
  onEvent: (key: string, event: EnrichEvent) => void;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const pairKey = (brewery: string, name: string) => `${brewery} ${name}`;

// Omits absent facts rather than sending nulls. `!== undefined` is load-bearing:
// an abv of 0 is real and must not be dropped as falsy (#369/#322).
// runEnrichment is exported, so it re-applies usableAbv rather than trusting its
// caller to have sanitized: JSON.stringify would turn a stray NaN into a null, and
// null is not a number the enrich schema can map to "no ABV".
// #384: the server's schema demands a positive integer bid; a malformed one would 400
// the whole relay, so it is dropped here for the same reason a stray ABV is.
const usableBid = (bid: number | undefined): number | undefined =>
  bid !== undefined && Number.isInteger(bid) && bid > 0 ? bid : undefined;

// #384: `brand` is the brewery the shop published next to the bid — after the adapter's
// detail hydration the card's brewery IS that brand. It is what the server's guard checks
// the Untappd record against, so slug and brand only travel when a usable bid does.
const orphanFacts = (o: OrphanFacts & { brewery?: string }): OrphanFacts => {
  const abv = usableAbv(o.abv);
  const bid = usableBid(o.bid);
  const brand = o.brand ?? o.brewery;
  return {
    ...(abv !== undefined ? { abv } : {}),
    ...(o.style !== undefined ? { style: o.style } : {}),
    ...(bid !== undefined ? { bid } : {}),
    ...(bid !== undefined && o.bidSlug !== undefined ? { bidSlug: o.bidSlug } : {}),
    ...(bid !== undefined && brand !== undefined ? { brand } : {}),
  };
};

// /enrich/candidates only answers "is this beer worth searching?", and for that the bid
// alone is the question ("does the shop's identity contradict the stored link?"). Sending
// the slug/brand it never reads would only inflate a 200-beer batch.
const candidateFacts = (o: OrphanBeer): OrphanFacts => {
  const { abv, style, bid } = orphanFacts(o);
  return {
    ...(abv !== undefined ? { abv } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(bid !== undefined ? { bid } : {}),
  };
};

// Registers every page orphan, then searches Untappd one at a time, throttled — but at
// most MAX_SEARCHES_PER_PAGE per page so a big shop page doesn't drain the user's session.
// The rest stay ⚪ for a later load / the server cron (same orphan pool + backoff).
export async function runEnrichment(orphans: OrphanBeer[], deps: EnrichDeps): Promise<void> {
  if (orphans.length === 0) return;

  // #648 (рев'ю PR #670): вердикт винен КОЖЕН, кого сюди передали, а не кожен, кого
  // повернув сервер. Усе нижче крутиться навколо `candidates`, тож порожня чи коротша
  // відповідь `/enrich/candidates` — відкликаний дозвіл на Untappd, помилка воркера,
  // `?? []` у клієнті — лишала б картки на «в черзі» назавжди. Рахуємо, кому вердикт уже
  // видали, і замітаємо решту в кінці.
  const resolved = new Set<string>();
  const emit = (key: string, event: EnrichEvent): void => {
    if (event.kind !== 'searching') resolved.add(key);
    deps.onEvent(key, event);
  };

  const candidates = await deps.getCandidates(
    orphans.map((o) => ({ brewery: o.brewery, name: o.name, ...candidateFacts(o) })),
  );
  const byPair = new Map(orphans.map((o) => [pairKey(o.brewery, o.name), o]));
  // #391: the budget counts SEARCHES, not beers. A two-rung ladder can cost two Algolia
  // calls, and what this cap protects is what the page draws from the user's session.
  // Beers past the cap are not lost: the orphan pool is shared with the next page load
  // and with the server cron.
  const eligible = candidates.filter((c) => c.eligible);

  // #648: картка, яку сервер не вважає вартою пошуку, вже має відповідь — вона просто не
  // покращиться. Без цього циклу вона лишалася б на «в черзі» назавжди, бо `/match`
  // намалював їй чергу саме під обіцянку дошуку, а дошук її мовчки не бере.
  for (const cand of candidates) {
    if (cand.eligible) continue;
    const beer = byPair.get(pairKey(cand.brewery, cand.name));
    if (beer) emit(beer.key, { kind: 'settled' });
  }

  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let searches = 0;
  // #648: скільки ПРИДАТНИХ карток цикл устиг узяти. Рахується окремо від `searches`:
  // одна картка може коштувати двох пошуків (драбина #382), тож ці два числа розходяться,
  // а зрізати хвіст черги треба саме по картках.
  let handled = 0;
  for (const cand of eligible) {
    if (searches >= MAX_SEARCHES_PER_PAGE) break;
    handled++;
    const beer = byPair.get(pairKey(cand.brewery, cand.name));
    if (!beer) continue;
    // Рев'ю PR #670: список кандидатів може повторити те саме пиво. Другий прохід з'їв би
    // ще один слот Algolia і перекинув би картку з кінцевого стану назад у «працюємо».
    if (resolved.has(beer.key)) continue;

    // Narrowest first. `algoliaNarrow` is absent unless the two rungs differ (#382).
    const rungs = cand.algoliaNarrow ? [cand.algoliaNarrow, cand.algolia] : [cand.algolia];

    emit(beer.key, { kind: 'searching' });
    try {
      let response: AlgoliaResponse | null = null;
      let query = rungs[0].query;
      // True only when a zero-hit rung left a wider rung unrun for want of budget.
      let abandoned = false;
      for (const r of rungs) {
        if (searches >= MAX_SEARCHES_PER_PAGE) { abandoned = true; break; }
        if (searches > 0) await sleep(delayMs);
        searches++;
        query = r.query;
        response = await deps.fetchSearch(r);
        // A rung that returned candidates is never widened on: the wide rung's result set
        // is a superset the matcher stages would only re-reject (#382 design §3.3).
        if (response === null || (response.hits?.length ?? 0) > 0) break;
      }

      // A half-run ladder is not a verdict. Submitting the empty narrow payload would make
      // the server record not_found and burn a backoff slot on a search we never finished.
      if (abandoned) {
        emit(beer.key, { kind: 'deferred' });
      } else if (response === null) {
        // The service worker got nothing back from Algolia at all. That is the same mute
        // failure as the catch below — calling it "not found" would claim a verdict no
        // search produced.
        emit(beer.key, { kind: 'failed', reason: 'network' });
      } else {
        const res = await deps.submitResult(cand.brewery, cand.name, response, orphanFacts(beer), query);
        if (res.status === 'matched' && res.untappd_id != null) {
          emit(beer.key, {
            kind: 'found',
            untappdId: res.untappd_id,
            ratingGlobal: res.rating_global ?? null,
          });
        } else if (res.status === 'blocked') {
          emit(beer.key, { kind: 'failed', reason: 'blocked' });
        } else if (res.status === 'transient') {
          emit(beer.key, { kind: 'failed', reason: 'network' });
        } else {
          // `not_found` / `skipped` / matched-without-an-id: the search ran and improved
          // nothing, so the card keeps whatever `/match` already proved about it.
          emit(beer.key, { kind: 'settled' });
        }
      }
    } catch {
      emit(beer.key, { kind: 'failed', reason: 'network' });
    }
  }

  // #648: усе, до чого цикл не дійшов. Ліміт — не мовчазний `break`: картка, яку ми не
  // подивилися, каже про це сама, бо інакше застрягає на «в черзі» до кінця сторінки.
  for (const cand of eligible.slice(handled)) {
    const beer = byPair.get(pairKey(cand.brewery, cand.name));
    if (beer) emit(beer.key, { kind: 'deferred' });
  }

  // Останній замет: те, про що сервер не сказав нічого. `deferred`, а не `settled` —
  // ми справді не дивилися, тож і твердити «не знайшли» не маємо права.
  for (const beer of orphans) {
    if (!resolved.has(beer.key)) emit(beer.key, { kind: 'deferred' });
  }
}
