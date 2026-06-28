import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import {
  findBeerByNormalized,
  getBeer,
  upsertBeer,
} from '../../storage/beers';
import { isWontfix } from '../../storage/enrich_failures';
import { normalizeBrewery, normalizeName, cleanSearchQuery } from '../../domain/normalize';
import { isEligible } from '../../domain/lookup-backoff';
import { htmlSearch } from '../../sources/untappd/search';
import {
  ALGOLIA_DEFAULTS,
  ALGOLIA_HITS_PER_PAGE,
  ALGOLIA_INDEX_NAME,
  parseAlgoliaResponse,
  type AlgoliaQuery,
  type AlgoliaResponse,
} from '../../sources/untappd/algolia';
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
  html: z.string().optional(),
  algolia: z.object({
    hits: z.array(z.record(z.string(), z.unknown())).optional(),
    nbHits: z.number().optional(),
  }).optional(),
  pageUrl: z.string().optional(),
}).refine((v) => typeof v.html === 'string' || v.algolia !== undefined, {
  message: 'html or algolia is required',
});

function algoliaQuery(deps: ApiDeps, query: string): AlgoliaQuery {
  return {
    appId: deps.env.UNTAPPD_ALGOLIA_APP_ID ?? ALGOLIA_DEFAULTS.appId,
    searchKey: deps.env.UNTAPPD_ALGOLIA_SEARCH_KEY ?? ALGOLIA_DEFAULTS.searchKey,
    indexName: ALGOLIA_INDEX_NAME,
    query,
    hitsPerPage: ALGOLIA_HITS_PER_PAGE,
  };
}

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
          !isWontfix(deps.db, row.id) &&
          isEligible(now, row.untappd_lookup_at, row.untappd_lookup_count);
        const query = cleanSearchQuery(b.brewery, b.name);
        return {
          brewery: b.brewery,
          name: b.name,
          eligible,
          algolia: algoliaQuery(deps, query),
        };
      }),
    )();
    return c.json({ candidates });
  });

  app.post('/enrich/result', zValidator('json', ResultBody), async (c) => {
    const { brewery, name, html, algolia, pageUrl } = c.req.valid('json');
    const row = ensureBeerRow(deps.db, brewery, name);
    // Only orphans are enrichable. Never overwrite / merge a canonical (already
    // matched) row from client-relayed input.
    if (row.untappd_id != null) {
      return c.json({ status: 'skipped' });
    }
    // Reuse the full server pick pipeline; the client already fetched, so the
    // injected search adapter just returns the relayed result payload.
    const search = algolia
      ? { search: async () => parseAlgoliaResponse(algolia as AlgoliaResponse) }
      : htmlSearch(html!);
    const outcome = await lookupBeer({ brewery, name, abv: row.abv, search });
    const nowIso = new Date().toISOString();
    // pageUrl (the shop page the beer was scraped from) becomes the failure row's sourceUrl.
    const kind = applyLookupOutcome({ db: deps.db, log: deps.log }, row.id, outcome, nowIso, { brewery, name, sourceUrl: pageUrl });
    if (kind === 'matched' && outcome.kind === 'matched') {
      return c.json({ status: 'matched', untappd_id: outcome.result.bid, rating_global: outcome.result.global_rating });
    }
    return c.json({ status: kind });
  });
}
