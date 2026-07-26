import type pino from 'pino';
import type { DB } from '../storage/db';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';
import { isEligible } from '../domain/lookup-backoff';
import { lookupBeer } from '../domain/untappd-lookup';
import { lookupWithFallback } from '../domain/web-fallback';
import { applyLookupOutcome } from '../domain/lookup-outcome';
import type { EnrichOutcomeKind } from '../domain/lookup-outcome';
import { getBeer } from '../storage/beers';

export type { EnrichOutcomeKind } from '../domain/lookup-outcome';

export interface EnrichDeps {
  db: DB;
  log: pino.Logger;
  search: BeerSearch;
  now?: () => Date;
  // Optional web 0-candidate fallback (null/undefined when unconfigured).
  webFallback?: ((beerId: number) => Promise<SearchResult | null>) | null;
}

export async function enrichOneOrphan(
  deps: EnrichDeps,
  beerId: number,
): Promise<EnrichOutcomeKind> {
  const beer = getBeer(deps.db, beerId);
  if (!beer || beer.untappd_id !== null) return 'skipped';

  const now = (deps.now ?? (() => new Date()))();
  if (!isEligible(now, beer.untappd_lookup_at, beer.untappd_lookup_count)) {
    return 'skipped';
  }

  const outcome = await lookupWithFallback(
    () => lookupBeer({ brewery: beer.brewery, name: beer.name, abv: beer.abv, search: deps.search }),
    beerId,
    deps.webFallback ?? null,
  );

  const nowIso = now.toISOString();
  return applyLookupOutcome(deps, beerId, outcome, nowIso, { brewery: beer.brewery, name: beer.name });
}
