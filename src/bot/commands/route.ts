import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { listPubs } from '../../storage/pubs';
import { latestSnapshotsPerPub, tapsForSnapshot } from '../../storage/snapshots';
import { drunkBeerIds } from '../../storage/checkins';
import { getMatch } from '../../storage/match_links';
import { getFilters } from '../../storage/user_filters';
import { filterInteresting } from '../../domain/filters';
import {
  buildRoute,
  haversineMeters,
  createOsrmDistance,
  type RoutePub,
} from '../../domain/router';

export const routeCommand = new Composer<BotContext>();

routeCommand.command('route', async (ctx) => {
  const db = ctx.deps.db;
  const arg = ctx.message.text.split(' ')[1];
  const N =
    parseInt(arg ?? '', 10) ||
    getFilters(db, ctx.from.id)?.default_route_n ||
    ctx.deps.env.DEFAULT_ROUTE_N;

  const drunk = drunkBeerIds(db, ctx.from.id);
  const filters =
    getFilters(db, ctx.from.id) ?? {
      styles: [],
      min_rating: null,
      abv_min: null,
      abv_max: null,
      default_route_n: null,
    };
  const pubsById = new Map(listPubs(db).map((p) => [p.id, p]));

  const routePubs: RoutePub[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
    const pub = pubsById.get(snap.pub_id);
    if (!pub || pub.lat == null || pub.lon == null) continue;
    const taps = tapsForSnapshot(db, snap.id).map((t) => ({
      beer_id: getMatch(db, t.beer_ref)?.untappd_beer_id ?? null,
      style: t.style,
      abv: t.abv,
      u_rating: t.u_rating,
    }));
    const interesting = filterInteresting(taps, drunk, filters).map((t) => t.beer_id!) as number[];
    if (!interesting.length) continue;
    routePubs.push({
      id: pub.id,
      lat: pub.lat,
      lon: pub.lon,
      interesting: new Set(interesting),
    });
  }

  if (!routePubs.length) {
    await ctx.reply('Немає цікавих непитих пив у поточному snapshot.');
    return;
  }

  const osrm = createOsrmDistance(ctx.deps.env.OSRM_BASE_URL);
  const n = routePubs.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const coordKey = (lat: number, lon: number) => `${lat},${lon}`;
  const idxByCoord = new Map(routePubs.map((p, i) => [coordKey(p.lat, p.lon), i]));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a: [number, number] = [routePubs[i].lat, routePubs[i].lon];
      const b: [number, number] = [routePubs[j].lat, routePubs[j].lon];
      let d: number;
      try {
        d = await osrm(a, b);
      } catch (e) {
        ctx.deps.log.warn({ err: e }, 'osrm failed, haversine');
        d = haversineMeters(a, b);
      }
      matrix[i][j] = d;
      matrix[j][i] = d;
    }
  }

  const distance = (a: [number, number], b: [number, number]): number => {
    const ia = idxByCoord.get(coordKey(a[0], a[1]));
    const ib = idxByCoord.get(coordKey(b[0], b[1]));
    if (ia === undefined || ib === undefined) return haversineMeters(a, b);
    return matrix[ia][ib];
  };

  const result = buildRoute(routePubs, N, { distance });
  const km = (result.distanceMeters / 1000).toFixed(1);
  const header = `Маршрут: ≥${N} нових пив, покрито ${result.coveredCount}, ≈ ${km} км, ${result.pubIds.length} пабів`;
  const lines = result.pubIds.map((id, i) => `${i + 1}. ${pubsById.get(id)!.name}`);
  await ctx.reply([header, '', ...lines].join('\n'));
});
