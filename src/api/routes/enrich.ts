import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { findBeerByNormalized, upsertBeer } from '../../storage/beers';
import { normalizeBrewery, normalizeName, stripBreweryNoise } from '../../domain/normalize';
import { isEligible } from '../../domain/lookup-backoff';
import { buildSearchUrl } from '../../sources/untappd/search';

const CandidatesBody = z.object({
  beers: z
    .array(z.object({ brewery: z.string(), name: z.string() }))
    .min(1)
    .max(200),
});

// Ensures an orphan row exists for (brewery, name) and returns it.
function ensureOrphan(db: ApiDeps['db'], brewery: string, name: string) {
  const normalized_brewery = normalizeBrewery(brewery);
  const normalized_name = normalizeName(name);
  let row = findBeerByNormalized(db, normalized_brewery, normalized_name);
  if (!row) {
    upsertBeer(db, {
      untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
      normalized_name, normalized_brewery,
    });
    row = findBeerByNormalized(db, normalized_brewery, normalized_name)!;
  }
  return row;
}

export function enrichRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/enrich/candidates', zValidator('json', CandidatesBody), (c) => {
    const { beers } = c.req.valid('json');
    const now = new Date();
    const candidates = beers.map((b) => {
      const row = ensureOrphan(deps.db, b.brewery, b.name);
      const eligible =
        row.untappd_id == null &&
        isEligible(now, row.untappd_lookup_at, row.untappd_lookup_count);
      return {
        brewery: b.brewery,
        name: b.name,
        eligible,
        searchUrl: buildSearchUrl(`${stripBreweryNoise(b.brewery)} ${b.name}`.trim()),
      };
    });
    return c.json({ candidates });
  });
}
