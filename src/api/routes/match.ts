import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { loadCatalog } from '../../storage/beers';
import { triedBeerIds } from '../../storage/untappd_had';
import { latestRatingsByBeer } from '../../storage/checkins';
import { matchBeerList } from '../../domain/match-list';

const MatchBody = z.object({
  beers: z
    .array(
      z.object({
        brewery: z.string(),
        name: z.string(),
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
  app.post('/match', zValidator('json', MatchBody), async (c) => {
    const telegramId = c.get('telegramId') ?? null;
    const { beers } = c.req.valid('json');

    const catalog = loadCatalog(deps.db);
    // Anonymous callers get global-only results: empty drunk/ratings sets mean
    // is_drunk=false, user_rating=null, but matched_beer still carries the global
    // rating + untappd_id (⭐/⚪ badges render unchanged).
    const drunkSet = telegramId === null ? new Set<number>() : triedBeerIds(deps.db, telegramId);
    const ratings = telegramId === null ? new Map<number, number>() : latestRatingsByBeer(deps.db, telegramId);

    const results = await matchBeerList(catalog, drunkSet, ratings, beers);
    return c.json({ results });
  });
}
