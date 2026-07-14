import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { createCatalogCache } from '../../domain/catalog-cache';
import { triedBeerIds } from '../../storage/untappd_had';
import { latestRatingsByBeer } from '../../storage/checkins';
import { matchBeerList } from '../../domain/match-list';
import { recordMatchUsage } from '../../storage/api_usage';
import { warsawDateAndHour } from '../../domain/warsaw-time';
import {
  BEER_TEXT_LIMIT_CHARS,
  MATCH_BODY_LIMIT_BYTES,
  payloadBodyLimit,
  payloadSizeValidationHook,
} from '../middleware/payload-limit';

const MatchBody = z.object({
  beers: z
    .array(
      z.object({
        brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
        name: z.string().max(BEER_TEXT_LIMIT_CHARS),
        abv: z.number().optional(),
      }),
    )
    .min(1)
    .max(200),
});

// Registers POST /match on the given app. Auth is optional here: a missing
// token yields telegramId===null (anonymous, global-only results); a valid
// token yields personal drunk/rating data (see optionalAuthMiddleware).
export function matchRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  const cache = createCatalogCache(deps.db, {
    onError: (err) => deps.log.error({ err }, 'catalog cache rebuild failed'),
  });
  app.post(
    '/match',
    payloadBodyLimit(deps, MATCH_BODY_LIMIT_BYTES, 'route'),
    zValidator('json', MatchBody, payloadSizeValidationHook(deps) as never),
    async (c) => {
    const telegramId = c.get('telegramId') ?? null;
    const { beers } = c.req.valid('json');

    // Operational usage metric for the daily digest — never break the response.
    try {
      recordMatchUsage(deps.db, {
        date: warsawDateAndHour(new Date()).date,
        authed: telegramId !== null,
        beers: beers.length,
      });
    } catch (e) {
      deps.log.warn({ err: e }, 'api_usage record failed');
    }

    const { prepared, byId } = await cache.get();
    // Anonymous callers get global-only results: empty drunk/ratings sets mean
    // is_drunk=false, user_rating=null, but matched_beer still carries the global
    // rating + untappd_id (⭐/⚪ badges render unchanged).
    const drunkSet = telegramId === null ? new Set<number>() : triedBeerIds(deps.db, telegramId);
    const ratings = telegramId === null ? new Map<number, number>() : latestRatingsByBeer(deps.db, telegramId);

    const { results, fallback } = await matchBeerList(prepared, byId, drunkSet, ratings, beers);
    deps.log.info(
      {
        items: beers.length,
        fullFallback: {
          attempts: fallback.attempts,
          hits: fallback.hits,
          budgetSkipped: fallback.budgetSkipped,
        },
      },
      'match fallback stats',
    );
    return c.json({ results });
    },
  );
}
