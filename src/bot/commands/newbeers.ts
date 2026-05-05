import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { latestSnapshotsPerPub, tapsForSnapshotWithBeer } from '../../storage/snapshots';
import { drunkBeerIds } from '../../storage/checkins';
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

export const newbeersCommand = new Composer<BotContext>();

newbeersCommand.command('newbeers', async (ctx) => {
  const db = ctx.deps.db;
  const drunk = drunkBeerIds(db, ctx.from.id);
  const filters =
    getFilters(db, ctx.from.id) ?? {
      styles: [],
      min_rating: null,
      abv_min: null,
      abv_max: null,
      default_route_n: null,
    };
  const pubs = new Map(listPubs(db).map((p) => [p.id, p]));

  const candidates: CandidateTap[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
    const pub = pubs.get(snap.pub_id);
    if (!pub) continue;
    const taps = tapsForSnapshotWithBeer(db, snap.id);
    const good = filterInteresting(taps, drunk, filters);
    for (const t of good) {
      const display = t.brewery_ref ? `${t.brewery_ref} ${t.beer_ref}`.trim() : t.beer_ref;
      candidates.push({
        beer_id: t.beer_id,
        display,
        brewery_norm: normalizeBrewery(t.brewery_ref ?? ''),
        name_norm: normalizeName(t.beer_ref),
        abv: t.abv,
        rating: t.u_rating,
        pub_name: pub.name,
      });
    }
  }

  const text = formatGroupedBeers(rankGroups(groupTaps(candidates)), ctx.locale, ctx.t);
  await ctx.replyWithHTML(text || ctx.t('newbeers.empty'));
});
