import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import {
  findBeerByNormalized,
  getBeer,
  upsertBeer,
} from '../../storage/beers';
import { normalizeBrewery, normalizeName, stripBreweryNoise } from '../../domain/normalize';
import { isEligible } from '../../domain/lookup-backoff';
import { buildSearchUrl } from '../../sources/untappd/search';
import { lookupBeer } from '../../domain/untappd-lookup';
import { applyLookupOutcome } from '../../domain/lookup-outcome';

const CandidatesBody = z.object({
  beers: z
    .array(z.object({ brewery: z.string(), name: z.string() }))
    .min(1)
    .max(200),
});

const ResultBody = z.object({
  brewery: z.string(),
  name: z.string(),
  html: z.string(),
  pageUrl: z.string().optional(),
});

// Ensures a beer row exists for (brewery, name) and returns it.
// May return a pre-existing matched row, not only a freshly created orphan.
function ensureBeerRow(db: ApiDeps['db'], brewery: string, name: string) {
  const normalized_brewery = normalizeBrewery(brewery);
  const normalized_name = normalizeName(name);
  const existing = findBeerByNormalized(db, normalized_brewery, normalized_name);
  if (existing) return existing;
  const id = upsertBeer(db, {
    untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
    normalized_name, normalized_brewery,
  });
  return getBeer(db, id)!;
}

export function enrichRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/enrich/candidates', zValidator('json', CandidatesBody), (c) => {
    const { beers } = c.req.valid('json');
    const now = new Date();
    const candidates = deps.db.transaction(() =>
      beers.map((b) => {
        const row = ensureBeerRow(deps.db, b.brewery, b.name);
        const eligible =
          row.untappd_id == null &&
          isEligible(now, row.untappd_lookup_at, row.untappd_lookup_count);
        return {
          brewery: b.brewery,
          name: b.name,
          eligible,
          searchUrl: buildSearchUrl(`${stripBreweryNoise(b.brewery)} ${b.name}`.trim()),
        };
      }),
    )();
    return c.json({ candidates });
  });

  app.post('/enrich/result', zValidator('json', ResultBody), async (c) => {
    const { brewery, name, html, pageUrl } = c.req.valid('json');
    const row = ensureBeerRow(deps.db, brewery, name);
    // Only orphans are enrichable. Never overwrite / merge a canonical (already
    // matched) row from client-relayed input.
    if (row.untappd_id != null) {
      return c.json({ status: 'skipped' });
    }
    // Reuse the full server pick pipeline; the client already fetched, so the
    // injected fetch just returns the relayed HTML regardless of URL.
    const outcome = await lookupBeer({ brewery, name, abv: row.abv, fetch: async () => html });
    const nowIso = new Date().toISOString();
    // pageUrl (the shop page the beer was scraped from) becomes the failure row's sourceUrl.
    const kind = applyLookupOutcome({ db: deps.db, log: deps.log }, row.id, outcome, nowIso, { brewery, name, sourceUrl: pageUrl });
    if (kind === 'matched' && outcome.kind === 'matched') {
      return c.json({ status: 'matched', untappd_id: outcome.result.bid, rating_global: outcome.result.global_rating });
    }
    return c.json({ status: kind });
  });
}
