import type { DB } from '../../storage/db';
import type { Locale, Translator } from '../../i18n/types';
import { latestSnapshotsPerPub, tapsForSnapshotWithBeer } from '../../storage/snapshots';
import { triedBeerIds } from '../../storage/untappd_had';
import { getFilters } from '../../storage/user_filters';
import { filterInteresting } from '../../domain/filters';
import { listPubs } from '../../storage/pubs';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';
import {
  groupTaps,
  rankGroups,
  formatGroupedBeers,
  type CandidateTap,
} from './newbeers-format';

export interface NewbeersDeps {
  db: DB;
  telegramId: number;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
}

export type NewbeersResult =
  | { kind: 'ok'; html: string }
  | { kind: 'empty' }
  | { kind: 'pub_not_found'; query: string };

export function buildNewbeersMessage(deps: NewbeersDeps): NewbeersResult {
  const { db, telegramId, locale, t } = deps;
  const tried = triedBeerIds(db, telegramId);
  const filters =
    getFilters(db, telegramId) ?? {
      styles: [],
      min_rating: null,
      abv_min: null,
      abv_max: null,
      default_route_n: null,
    };
  const pubs = new Map(listPubs(db).map((p) => [p.id, p]));

  const q = deps.pubQuery?.trim().toLowerCase();
  let matchedIds: Set<number> | null = null;
  if (q) {
    const matched = [...pubs.values()].filter((p) => p.name.toLowerCase().includes(q));
    if (matched.length === 0) {
      // Preserve user's original casing/whitespace in the error message.
      return { kind: 'pub_not_found', query: deps.pubQuery! };
    }
    matchedIds = new Set(matched.map((p) => p.id));
  }

  const candidates: CandidateTap[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
    if (matchedIds && !matchedIds.has(snap.pub_id)) continue;
    const pub = pubs.get(snap.pub_id);
    if (!pub) continue;
    const taps = tapsForSnapshotWithBeer(db, snap.id);
    const good = filterInteresting(taps, tried, filters);
    for (const tap of good) {
      const display = tap.brewery_ref ? `${tap.brewery_ref} ${tap.beer_ref}`.trim() : tap.beer_ref;
      candidates.push({
        beer_id: tap.beer_id,
        display,
        brewery_norm: normalizeBrewery(tap.brewery_ref ?? ''),
        name_norm: normalizeName(tap.beer_ref),
        abv: tap.abv,
        rating: tap.u_rating,
        pub_name: pub.name,
      });
    }
  }

  const text = formatGroupedBeers(rankGroups(groupTaps(candidates)), locale, t);
  return text ? { kind: 'ok', html: text } : { kind: 'empty' };
}
