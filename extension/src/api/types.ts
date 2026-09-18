export interface RawBeer {
  brewery: string;
  name: string;
  abv?: number;
  /** #633: the Untappd id the shop publishes on its own product page. */
  bid?: number;
  /** #633: the brand from that page — the brewery evidence the server checks the bid against. */
  brand?: string;
}

export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
  untappd_id: number | null;
}

export interface MatchResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  drunk_uncertain: boolean;
  user_rating: number | null;
  /**
   * #648: the server has always sent these two — `src/api/routes/match.ts` returns the
   * full `MatchListResult` — but the client never declared them, so they arrived over
   * the wire and were dropped on the floor. `source: 'fuzzy'` is the single source of
   * doubt, and it already carries a shop-published bid that contradicts the brewery (#633).
   */
  source: 'exact' | 'fuzzy' | null;
  /** false — the full-catalog fallback budget (#279) denied this item a search. */
  searched: boolean;
}

export interface MatchResponse {
  results: MatchResult[];
}

export interface AlgoliaQuery {
  appId: string;
  searchKey: string;
  indexName: 'beer';
  query: string;
  hitsPerPage: number;
}

export interface AlgoliaResponse {
  hits?: Record<string, unknown>[];
  nbHits?: number;
}

export interface EnrichCandidate {
  brewery: string;
  name: string;
  eligible: boolean;
  /** The wide rung — what this field has always carried (#391). */
  algolia: AlgoliaQuery;
  /**
   * #391: the narrow rung of the #382 ladder, present only when it differs from `algolia`.
   * Executed FIRST; `algolia` is the fallback for a zero-hit narrow result.
   */
  algoliaNarrow?: AlgoliaQuery;
}

export interface EnrichResult {
  status: 'matched' | 'not_found' | 'blocked' | 'transient' | 'skipped';
  untappd_id?: number;
  rating_global?: number | null;
}

export interface CheckinSyncState {
  username: string;
  deepest_max_id: string | null;
  complete: boolean;
  serverCount: number;
  profileTotal: number | null;
}

export interface CheckinSyncPageResult {
  merged: number;
  alreadyKnown: number;
  pageSize: number;
  nextMaxId: string | null;
  /** #587: куди йти далі. Рахує сервер, стрибаючи через покриту територію. `null` = роботи немає. */
  nextCursor: string | null;
  profileTotal: number | null;
  serverCount: number;
  complete: boolean;
}
