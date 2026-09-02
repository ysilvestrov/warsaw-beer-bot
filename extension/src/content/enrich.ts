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
  setSearching: (key: string) => void;
  setEnriched: (key: string, untappdId: number, ratingGlobal: number | null) => void;
  setOrphan: (key: string, brewery: string, name: string) => void;
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

  const candidates = await deps.getCandidates(
    orphans.map((o) => ({ brewery: o.brewery, name: o.name, ...candidateFacts(o) })),
  );
  const byPair = new Map(orphans.map((o) => [pairKey(o.brewery, o.name), o]));
  // #391: the budget counts SEARCHES, not beers. A two-rung ladder can cost two Algolia
  // calls, and what this cap protects is what the page draws from the user's session.
  // Beers past the cap are not lost: the orphan pool is shared with the next page load
  // and with the server cron.
  const eligible = candidates.filter((c) => c.eligible);

  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let searches = 0;
  for (const cand of eligible) {
    if (searches >= MAX_SEARCHES_PER_PAGE) break;
    const beer = byPair.get(pairKey(cand.brewery, cand.name));
    if (!beer) continue;

    // Narrowest first. `algoliaNarrow` is absent unless the two rungs differ (#382).
    const rungs = cand.algoliaNarrow ? [cand.algoliaNarrow, cand.algolia] : [cand.algolia];

    deps.setSearching(beer.key);
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
      const res = !abandoned && response
        ? await deps.submitResult(cand.brewery, cand.name, response, orphanFacts(beer), query)
        : null;
      if (res && res.status === 'matched' && res.untappd_id != null) {
        deps.setEnriched(beer.key, res.untappd_id, res.rating_global ?? null);
      } else {
        deps.setOrphan(beer.key, cand.brewery, cand.name);
      }
    } catch {
      deps.setOrphan(beer.key, cand.brewery, cand.name);
    }
  }
}
