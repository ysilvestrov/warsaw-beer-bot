import { ABV_TOLERANCE } from './matcher';
import type { SearchResult } from '../sources/untappd/search';

// #487: asked for "a Guinness", nobody means Guinness Bitter — they mean the beer with
// ~992k ratings. Popularity is identity evidence when ONE candidate dominates, and no
// evidence at all when two siblings are neck and neck (1664 vs 1664 Blanc: 1.09x).
// Measured 2026-08-25 across every bare-brand orphan row: the correct flagships sit at
// 5.89x-326x and the coin flips at 1.09x-2.45x. Nothing lies in between.
export const DOMINANCE_RATIO = 5;

// A lone candidate has infinite dominance by arithmetic, which is not the same as being
// the beer people mean. The correct flagships carry 36k-625k ratings; the rejected noise
// carries 73-1448.
export const FLAGSHIP_MIN_RATINGS = 1000;

// True popularity or nothing: a transport that does not report ratings (the legacy HTML
// relay) must leave the candidate ineligible, never look like a beer with zero ratings.
function ratingCount(result: SearchResult): number | undefined {
  return typeof result.rating_count === 'number' ? result.rating_count : undefined;
}

/**
 * The single candidate this list is *about*, or null when the list does not say.
 * ABV is a veto here, never a selector: a contradicting leader means "no flagship",
 * not "take the next one" — promoting the runner-up would rebuild #487.
 */
export function dominantCandidate(results: SearchResult[], abv: number | null): SearchResult | null {
  const unique = Array.from(new Map(results.map((r) => [r.bid, r])).values());
  if (unique.length === 0) return null;

  const ranked = [...unique].sort((a, b) => (ratingCount(b) ?? -1) - (ratingCount(a) ?? -1));
  const leader = ranked[0];
  const leaderCount = ratingCount(leader);
  if (leaderCount === undefined || leaderCount < FLAGSHIP_MIN_RATINGS) return null;

  const runnerUpCount = ranked.length > 1 ? ratingCount(ranked[1]) : undefined;
  if (runnerUpCount !== undefined && runnerUpCount > 0 && leaderCount / runnerUpCount < DOMINANCE_RATIO) {
    return null;
  }

  if (abv != null && leader.abv != null && Math.abs(leader.abv - abv) > ABV_TOLERANCE) return null;

  return leader;
}
