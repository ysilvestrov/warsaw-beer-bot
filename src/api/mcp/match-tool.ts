import type { DB } from '../../storage/db';
import type { CatalogCache } from '../../domain/catalog-cache';
import type { FallbackBudget } from '../../domain/matcher';
import { matchBeerList, type MatchInput, type MatchListResult } from '../../domain/match-list';
import { triedBeerIds, hadBeerIds } from '../../storage/untappd_had';
import { latestRatingsByBeer, countCheckins, latestCheckinAt } from '../../storage/checkins';

/**
 * What we are willing to assert about one submitted beer.
 *
 * `not_in_catalog` and `not_searched` are deliberately separate: the budgeted
 * full-catalog fallback (#279) leaves items unexamined, and reporting those as absent
 * would be an assertion about data we never looked at. `not_searched` means only that
 * the budgeted catalogue-wide fuzzy fallback was denied for this item — the exact-match
 * stages DID run and missed, so a miss here is not evidence the beer is absent from the
 * catalog.
 *
 * `unknown` replaces `not_drunk` when we hold nothing at all about this user's drinking:
 * "you have not drunk this" is a claim about the person, and an empty drunk set does not
 * support it. The catalogue half of the answer is unaffected.
 */
export type MatchStatus =
  | 'drunk' | 'probably_drunk' | 'not_drunk' | 'unknown' | 'not_in_catalog' | 'not_searched';

export interface MatchToolBeer {
  name: string;
  brewery: string;
  rating_global: number | null;
  untappd_url: string | null;
}

export interface MatchToolItem {
  input: { brewery: string; name: string };
  status: MatchStatus;
  /** How sure the match itself is; null when nothing matched. */
  confidence: 'exact' | 'fuzzy' | null;
  beer: MatchToolBeer | null;
  your_rating: number | null;
}

/** The evidence every personal claim above rests on. */
export interface MatchToolProfile {
  checkins_known: number;
  untappd_had_known: number;
  latest_checkin_at: string | null;
  /**
   * True exactly when the drunk set (checkins ∪ untappd_had, the same set `statusFor`
   * reads) is empty — the same condition that downgrades `not_drunk` to `unknown`.
   * NOT derived from `checkins_known === 0`: a check-in row with a null `beer_id`
   * (never matched to a catalog beer) counts toward `checkins_known` but contributes
   * nothing to the drunk set, so the two can disagree.
   */
  drunk_set_empty: boolean;
}

export interface MatchToolOutput {
  profile: MatchToolProfile;
  results: MatchToolItem[];
}

export interface MatchToolRun {
  output: MatchToolOutput;
  fallback: FallbackBudget;
}

function statusFor(r: MatchListResult, drunkSetEmpty: boolean): MatchStatus {
  if (r.matched_beer === null) return r.searched ? 'not_in_catalog' : 'not_searched';
  if (r.is_drunk) return 'drunk';
  if (r.drunk_uncertain) return 'probably_drunk';
  return drunkSetEmpty ? 'unknown' : 'not_drunk';
}

export async function runMatchTool(
  db: DB,
  catalog: CatalogCache,
  telegramId: number,
  beers: MatchInput[],
): Promise<MatchToolRun> {
  const { prepared, byId } = await catalog.get();
  const drunkSet = triedBeerIds(db, telegramId);       // two-source model: checkins ∪ untappd_had
  const ratings = latestRatingsByBeer(db, telegramId);
  const { results, fallback } = await matchBeerList(prepared, byId, drunkSet, ratings, beers);
  const drunkSetEmpty = drunkSet.size === 0;

  return {
    fallback,
    output: {
      profile: {
        checkins_known: countCheckins(db, telegramId),
        untappd_had_known: hadBeerIds(db, telegramId).size,
        latest_checkin_at: latestCheckinAt(db, telegramId),
        drunk_set_empty: drunkSetEmpty,
      },
      results: results.map((r) => ({
        input: r.raw,
        status: statusFor(r, drunkSetEmpty),
        confidence: r.source,
        beer: r.matched_beer === null ? null : {
          name: r.matched_beer.name,
          brewery: r.matched_beer.brewery,
          rating_global: r.matched_beer.rating_global,
          // beers.untappd_id is the real Untappd id; match_links.untappd_beer_id is a
          // LOCAL beers.id and must never be used to build a link (§5.2).
          untappd_url: r.matched_beer.untappd_id === null
            ? null
            : `https://untappd.com/beer/${r.matched_beer.untappd_id}`,
        },
        your_rating: r.user_rating,
      })),
    },
  };
}

/** Plain-text mirror of the structured output, for clients that only show text. */
export function renderMatchToolText(o: MatchToolOutput): string {
  const lines: string[] = [
    `profile: ${o.profile.checkins_known} check-ins, ${o.profile.untappd_had_known} marked had`
    + `, latest check-in ${o.profile.latest_checkin_at ?? 'none'}`,
  ];
  if (o.profile.drunk_set_empty) {
    lines.push('NOTE: nothing is known about this user\'s drinking, so no beer can be reported as undrunk.');
  }
  for (const r of o.results) {
    const beer = r.beer === null
      ? '—'
      : `${r.beer.brewery} / ${r.beer.name}, global ${r.beer.rating_global ?? 'n/a'}`
        + `${r.beer.untappd_url === null ? '' : `, ${r.beer.untappd_url}`}`;
    const rating = r.your_rating === null ? '' : `, your rating ${r.your_rating}`;
    const conf = r.confidence === null ? '' : ` [${r.confidence}]`;
    const caveat = r.status === 'not_searched'
      ? ' (full-catalog search budget exhausted for this item — this is NOT evidence the beer is absent from the catalog)'
      : '';
    lines.push(`- ${r.input.brewery} / ${r.input.name} → ${r.status}${conf}${rating} · ${beer}${caveat}`);
  }
  return lines.join('\n');
}
