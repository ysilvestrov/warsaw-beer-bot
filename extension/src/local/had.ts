import type { MatchResult } from '../api/types';
import { allCheckins, type LocalCheckin } from './db';

// #924 §5: "had" in local mode. The /match answer stays anonymous (and so does the cache); the
// person's ✅/❓/rating is laid over it on every read from this index of bid → latest rating.
export type HadIndex = Map<number, number | null>;

const newer = (a: LocalCheckin, b: LocalCheckin): boolean =>
  a.checkin_at !== b.checkin_at ? a.checkin_at > b.checkin_at : Number(a.checkin_id) > Number(b.checkin_id);

/** bid → the rating of the newest rated check-in of that beer (the server's latestRatingsByBeer), else null. */
export function buildHadIndex(rows: LocalCheckin[]): HadIndex {
  const index: HadIndex = new Map();
  const ratedAt = new Map<number, LocalCheckin>();
  for (const row of rows) {
    if (!index.has(row.bid)) index.set(row.bid, null);
    if (row.user_rating === null) continue;
    const seen = ratedAt.get(row.bid);
    if (!seen || newer(row, seen)) {
      ratedAt.set(row.bid, row);
      index.set(row.bid, row.user_rating);
    }
  }
  return index;
}

/** The answer as an anonymous /match gives it: nothing about the person. */
export function anonymous(result: MatchResult): MatchResult {
  return { ...result, is_drunk: false, drunk_uncertain: false, user_rating: null };
}

/** The rule of src/domain/match-list.ts, word for word: exact → ✅ and rating, fuzzy → ❓. */
export function overlayHad(result: MatchResult, index: HadIndex): MatchResult {
  const bid = result.matched_beer?.untappd_id ?? null;
  if (bid === null || !index.has(bid)) return anonymous(result);
  return {
    ...result,
    is_drunk: result.source === 'exact',
    drunk_uncertain: result.source === 'fuzzy',
    user_rating: result.source === 'exact' ? index.get(bid) ?? null : null,
  };
}

let cached: HadIndex | null = null;
// Bumped by every invalidation: a build that started before a page write must not be kept after it.
let version = 0;

/**
 * Built once per service-worker life and dropped after every page write and Clear. A database
 * that cannot be read gives an empty index (the anonymous answer), not a failed /match; that
 * empty index is not kept, so the next read tries again.
 */
export async function hadIndex(): Promise<HadIndex> {
  if (cached) return cached;
  const started = version;
  try {
    const built = buildHadIndex(await allCheckins());
    if (started === version) cached = built;
    return built;
  } catch (error) {
    console.warn('[beer-overlay] local check-ins unreadable; showing the anonymous answer', error);
    return new Map();
  }
}

export function invalidateHadIndex(): void {
  cached = null;
  version++;
}
