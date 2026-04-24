import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { latestSnapshotsPerPub, tapsForSnapshot } from '../../storage/snapshots';
import { drunkBeerIds } from '../../storage/checkins';
import { getMatch } from '../../storage/match_links';
import { getFilters } from '../../storage/user_filters';
import { filterInteresting, rankByRating } from '../../domain/filters';
import { listPubs } from '../../storage/pubs';

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

  const ranked: { pubName: string; beer: string; rating: number | null }[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
    const taps = tapsForSnapshot(db, snap.id).map((t) => ({
      beer_id: getMatch(db, t.beer_ref)?.untappd_beer_id ?? null,
      style: t.style,
      abv: t.abv,
      u_rating: t.u_rating,
      beer_ref: t.beer_ref,
    }));
    const good = filterInteresting(taps, drunk, filters);
    for (const t of rankByRating(good).slice(0, 3)) {
      ranked.push({
        pubName: pubs.get(snap.pub_id)!.name,
        beer: t.beer_ref,
        rating: t.u_rating,
      });
    }
  }

  ranked.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const head = ranked.slice(0, 15).map((r) => `• ${r.beer} — ${r.pubName} (${r.rating ?? '—'})`);
  await ctx.reply(head.length ? head.join('\n') : 'Нічого цікавого — спробуй /refresh.');
});
