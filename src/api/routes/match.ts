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

// Registers POST /match on the given app. Assumes auth middleware has set
// 'telegramId' on the context for this route.
export function matchRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/match', zValidator('json', MatchBody), async (c) => {
    const telegramId = c.get('telegramId');
    const { beers } = c.req.valid('json');

    const catalog = loadCatalog(deps.db);
    const drunkSet = triedBeerIds(deps.db, telegramId);
    const ratings = latestRatingsByBeer(deps.db, telegramId);

    const results = await matchBeerList(catalog, drunkSet, ratings, beers);
    return c.json({ results });
  });
}
