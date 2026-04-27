import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { listPubs } from '../../storage/pubs';
import { latestSnapshotsPerPub, tapsForSnapshot } from '../../storage/snapshots';
import { drunkBeerIds } from '../../storage/checkins';
import { getMatch } from '../../storage/match_links';
import { getFilters } from '../../storage/user_filters';
import { filterInteresting } from '../../domain/filters';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';
import {
  buildRoute,
  haversineMeters,
  createOsrmDistance,
  createOsrmTable,
  type RoutePub,
} from '../../domain/router';
import {
  getDistancesFor,
  pairKey,
  putDistances,
  type DistanceSource,
} from '../../storage/pub_distances';
import { makeThrottledProgress } from './refresh';
import {
  groupTaps,
  rankGroups,
  type CandidateTap,
} from './newbeers-format';
import { formatRouteResult, type RoutePubFormat } from './route-format';

const PROGRESS_MIN_INTERVAL_MS = 2000;

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
  const interestingByPub = new Map<number, CandidateTap[]>();
  for (const snap of latestSnapshotsPerPub(db)) {
    const pub = pubsById.get(snap.pub_id);
    if (!pub || pub.lat == null || pub.lon == null) continue;
    const taps = tapsForSnapshot(db, snap.id).map((t) => ({
      beer_id: getMatch(db, t.beer_ref)?.untappd_beer_id ?? null,
      style: t.style,
      abv: t.abv,
      u_rating: t.u_rating,
      beer_ref: t.beer_ref,
      brewery_ref: t.brewery_ref,
    }));
    const good = filterInteresting(taps, drunk, filters);
    if (!good.length) continue;
    routePubs.push({
      id: pub.id,
      lat: pub.lat,
      lon: pub.lon,
      interesting: new Set(good.map((t) => t.beer_id!) as number[]),
    });
    interestingByPub.set(
      pub.id,
      good.map((t) => ({
        beer_id: t.beer_id,
        display: t.brewery_ref ? `${t.brewery_ref} ${t.beer_ref}`.trim() : t.beer_ref,
        brewery_norm: normalizeBrewery(t.brewery_ref ?? ''),
        name_norm: normalizeName(t.beer_ref),
        abv: t.abv,
        rating: t.u_rating,
        pub_name: pub.name,
      })),
    );
  }

  if (!routePubs.length) {
    await ctx.reply('Немає цікавих непитих пив у поточному snapshot.');
    return;
  }

  const status = await ctx.reply(`⏳ Будую маршрут для ≥${N} нових пив…`);
  const chatId = ctx.chat.id;
  const messageId = status.message_id;
  const telegram = ctx.telegram;
  const log = ctx.deps.log;
  const env = ctx.deps.env;
  const notify = makeThrottledProgress(
    async (text) => {
      await telegram
        .editMessageText(chatId, messageId, undefined, text, { parse_mode: 'HTML' })
        .catch(() => {});
    },
    PROGRESS_MIN_INTERVAL_MS,
  );

  // Detach the work: even with /table API + DB cache, a cold call still
  // exceeds Telegraf's 90s handlerTimeout on a fresh deploy. Captured locals
  // above keep the background promise independent of ctx's lifetime.
  void (async () => {
    try {
      const n = routePubs.length;
      const totalPairs = (n * (n - 1)) / 2;
      const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
      const coordKey = (lat: number, lon: number) => `${lat},${lon}`;
      const idxByCoord = new Map(routePubs.map((p, i) => [coordKey(p.lat, p.lon), i]));

      const cached = getDistancesFor(db, routePubs.map((p) => p.id));
      const missing: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const c = cached.get(pairKey(routePubs[i].id, routePubs[j].id));
          if (c) {
            matrix[i][j] = c.meters;
            matrix[j][i] = c.meters;
          } else {
            missing.push([i, j]);
          }
        }
      }

      const cachedCount = totalPairs - missing.length;
      await notify(
        `🗺 Матриця відстаней: ${cachedCount}/${totalPairs} з кешу, ${missing.length} нових`,
        { force: true },
      );

      if (missing.length) {
        const involvedSet = new Set<number>();
        for (const [i, j] of missing) { involvedSet.add(i); involvedSet.add(j); }
        const involved = [...involvedSet];
        const subPoints: [number, number][] = involved.map(
          (i) => [routePubs[i].lat, routePubs[i].lon],
        );
        const subIndex = new Map(involved.map((idx, sub) => [idx, sub]));

        const fresh: { idA: number; idB: number; meters: number; source: DistanceSource }[] = [];
        let table: number[][] | null = null;
        try {
          table = await createOsrmTable(env.OSRM_BASE_URL)(subPoints);
        } catch (e) {
          log.warn({ err: e }, 'osrm /table failed, fall back per-pair');
        }

        if (table) {
          for (const [i, j] of missing) {
            const d = table[subIndex.get(i)!][subIndex.get(j)!];
            matrix[i][j] = d;
            matrix[j][i] = d;
            fresh.push({ idA: routePubs[i].id, idB: routePubs[j].id, meters: d, source: 'osrm' });
          }
        } else {
          const osrm = createOsrmDistance(env.OSRM_BASE_URL);
          let done = 0;
          for (const [i, j] of missing) {
            const a: [number, number] = [routePubs[i].lat, routePubs[i].lon];
            const b: [number, number] = [routePubs[j].lat, routePubs[j].lon];
            let d: number;
            let source: DistanceSource;
            try {
              d = await osrm(a, b);
              source = 'osrm';
            } catch (err) {
              log.warn({ err }, 'osrm failed, haversine');
              d = haversineMeters(a, b);
              source = 'haversine';
            }
            matrix[i][j] = d;
            matrix[j][i] = d;
            fresh.push({ idA: routePubs[i].id, idB: routePubs[j].id, meters: d, source });
            done++;
            await notify(`🗺 Догружаю пари без кешу: ${done}/${missing.length}`);
          }
        }

        putDistances(db, fresh);
      }

      await notify('🧠 Шукаю найкоротший обхід…', { force: true });

      const distance = (a: [number, number], b: [number, number]): number => {
        const ia = idxByCoord.get(coordKey(a[0], a[1]));
        const ib = idxByCoord.get(coordKey(b[0], b[1]));
        if (ia === undefined || ib === undefined) return haversineMeters(a, b);
        return matrix[ia][ib];
      };

      const result = buildRoute(routePubs, N, { distance });
      const pubsInOrder: RoutePubFormat[] = result.pubIds.map((id) => {
        const taps = interestingByPub.get(id) ?? [];
        const ranked = rankGroups(groupTaps(taps));
        return {
          name: pubsById.get(id)!.name,
          beers: ranked.map((g) => ({ display: g.display, rating: g.rating, abv: g.abv })),
        };
      });
      const text = formatRouteResult({
        N,
        distanceMeters: result.distanceMeters,
        pubsInOrder,
      });
      await notify(text, { force: true });
    } catch (e) {
      log.error({ err: e }, 'route failed');
      await notify('❌ Не вдалось побудувати маршрут — подивись логи.', { force: true });
    }
  })();
});
