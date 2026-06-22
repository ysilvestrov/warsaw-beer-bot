import type { DB } from '../../storage/db';
import type { Locale, Translator } from '../../i18n/types';
import { latestSnapshotsPerPub, tapsForSnapshotWithBeer } from '../../storage/snapshots';
import { triedBeerIds } from '../../storage/untappd_had';
import { getFilters } from '../../storage/user_filters';
import { filterInteresting, type FilterOpts } from '../../domain/filters';
import { listPubs, type PubRow } from '../../storage/pubs';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';
import { isOntapEmptyTapRef } from '../../sources/ontap/pub';
import {
  groupTaps,
  rankGroups,
  formatGroupedBeers,
  type CandidateTap,
} from './newbeers-format';

export function filterPubsByQuery(pubs: PubRow[], query: string): PubRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return pubs;

  const nameMatches = pubs.filter((p) => p.name.toLowerCase().includes(q));

  if (nameMatches.length === 1) return nameMatches;

  const words = q.split(/\s+/).filter(Boolean);
  const searchBase = nameMatches.length === 0 ? pubs : nameMatches;
  const combined = searchBase.filter((p) =>
    words.every((w) => (p.name + ' ' + (p.address ?? '')).toLowerCase().includes(w)),
  );

  if (nameMatches.length === 0) return combined;
  return combined.length === 1 ? combined : nameMatches;
}

export interface NewbeersDeps {
  db: DB;
  telegramId: number;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
  city: string;
}

export type NewbeersResult =
  | { kind: 'ok'; html: string }
  | { kind: 'empty' }
  | { kind: 'pub_not_found'; query: string };

const hasActiveBeerFilters = (filters: FilterOpts): boolean =>
  Boolean(filters.styles?.length) ||
  filters.min_rating != null ||
  filters.abv_min != null ||
  filters.abv_max != null;

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
  const pubs = new Map(listPubs(db, deps.city).map((p) => [p.id, p]));

  const q = deps.pubQuery?.trim().toLowerCase() ?? '';
  let matchedIds: Set<number> | null = null;
  if (q) {
    const filtered = filterPubsByQuery([...pubs.values()], q);
    if (filtered.length === 0) return { kind: 'pub_not_found', query: deps.pubQuery! };
    matchedIds = new Set(filtered.map((p) => p.id));
  }

  const candidates: CandidateTap[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
    if (matchedIds && !matchedIds.has(snap.pub_id)) continue;
    const pub = pubs.get(snap.pub_id);
    if (!pub) continue;
    const taps = tapsForSnapshotWithBeer(db, snap.id);
    const good = filterInteresting(taps, tried, {
      ...filters,
      require_untappd_match: hasActiveBeerFilters(filters),
    });
    for (const tap of good) {
      if (isOntapEmptyTapRef(tap.beer_ref)) continue;
      const display = tap.brewery_ref ? `${tap.brewery_ref} ${tap.beer_ref}`.trim() : tap.beer_ref;
      candidates.push({
        beer_id: tap.beer_id,
        untappd_id: tap.untappd_id,
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
