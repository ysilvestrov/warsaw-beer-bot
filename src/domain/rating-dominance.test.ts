import { dominantCandidate, DOMINANCE_RATIO, FLAGSHIP_MIN_RATINGS } from './rating-dominance';
import type { SearchResult } from '../sources/untappd/search';

function beer(bid: number, rating_count: number | undefined, abv: number | null = 5): SearchResult {
  return { bid, beer_name: `b${bid}`, brewery_name: 'Brewery', style: null, abv, global_rating: null, rating_count };
}

describe('dominantCandidate', () => {
  test('returns the leader when it out-rates the runner-up by the ratio', () => {
    const hit = dominantCandidate([beer(1, 10000), beer(2, 1000)], null);
    expect(hit?.bid).toBe(1);
  });

  test('returns null when the lead is thinner than the ratio', () => {
    // Row 196: 1664 (292835) vs 1664 Blanc (269076) — 1.09x is not evidence.
    expect(dominantCandidate([beer(1, 292835), beer(2, 269076)], null)).toBeNull();
  });

  test('ranks by rating_count, not by input order', () => {
    const hit = dominantCandidate([beer(2, 1000), beer(1, 10000)], null);
    expect(hit?.bid).toBe(1);
  });

  test('deduplicates by bid before ranking', () => {
    // The same beer arriving twice must not become its own runner-up.
    const hit = dominantCandidate([beer(1, 10000), beer(1, 10000)], null);
    expect(hit?.bid).toBe(1);
  });

  test('a lone candidate above the floor is dominant', () => {
    expect(dominantCandidate([beer(1, FLAGSHIP_MIN_RATINGS)], null)?.bid).toBe(1);
  });

  test('a lone candidate below the floor is not a flagship', () => {
    // 73 ratings is the only hit, not the beer everyone means.
    expect(dominantCandidate([beer(1, 73)], null)).toBeNull();
  });

  test('a candidate with no rating_count does not become the leader', () => {
    // The sort demotes undefined below any defined count, so beer(2) becomes the leader
    // and fails the floor check (10 < 1000).
    expect(dominantCandidate([beer(1, undefined), beer(2, 10)], null)).toBeNull();
  });

  test('a runner-up with no rating_count skips the ratio check, same as an explicit zero', () => {
    // Absent evidence must not manufacture an infinite ratio. Note this coincides with an
    // explicit `0` only FOR THE RUNNER-UP (both skip the ratio check below); the leader's
    // undefined-vs-zero distinction still matters — see the floor checks lower in this file.
    expect(dominantCandidate([beer(1, 5000), beer(2, undefined)], null)?.bid).toBe(1);
    expect(dominantCandidate([beer(1, 5000), beer(2, 4000)], null)).toBeNull();
  });

  test('a contradicting ABV vetoes the flagship and does not promote the runner-up', () => {
    const results = [beer(1, 100000, 9), beer(2, 1000, 7)];
    expect(dominantCandidate(results, 7)).toBeNull();
  });

  test('an ABV difference exactly at the tolerance is not a contradiction', () => {
    // Breznak: shop 4.8, Untappd 5.1.
    expect(dominantCandidate([beer(1, 57139, 5.1), beer(2, 7601, 3.8)], 4.8)?.bid).toBe(1);
  });

  test('an unknown ABV on either side cannot veto', () => {
    expect(dominantCandidate([beer(1, 100000, null), beer(2, 1000, 5)], 7)?.bid).toBe(1);
    expect(dominantCandidate([beer(1, 100000, 9), beer(2, 1000, 5)], null)?.bid).toBe(1);
  });

  test('an empty list has no flagship', () => {
    expect(dominantCandidate([], 5)).toBeNull();
  });

  test('the constants are the reviewed values', () => {
    expect(DOMINANCE_RATIO).toBe(5);
    expect(FLAGSHIP_MIN_RATINGS).toBe(1000);
  });

  test('an explicit zero is a real count, not absent evidence', () => {
    // A leader with 0 ratings is below the floor, so there is no flagship...
    expect(dominantCandidate([beer(1, 0), beer(2, 0)], null)).toBeNull();
    // ...but a runner-up with a real 0 does not hold the leader back.
    expect(dominantCandidate([beer(1, 5000), beer(2, 0)], null)?.bid).toBe(1);
  });

  test('an undefined-only candidate list has no flagship', () => {
    // Reaches the `leaderCount === undefined` guard: with no real count anywhere,
    // the leader itself is absent evidence and must not be promoted.
    expect(dominantCandidate([beer(1, undefined)], null)).toBeNull();
    expect(dominantCandidate([beer(1, undefined), beer(2, undefined)], null)).toBeNull();
  });
});
