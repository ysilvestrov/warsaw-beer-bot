import type pino from 'pino';
import type { DB } from '../storage/db';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';
import { isEligible, RECURRING_CLASSES } from '../domain/lookup-backoff';
import { lookupBeer } from '../domain/untappd-lookup';
import { lookupWithFallback } from '../domain/web-fallback';
import { applyLookupOutcome } from '../domain/lookup-outcome';
import type { EnrichOutcomeKind } from '../domain/lookup-outcome';
import { getBeer } from '../storage/beers';
import { reviewClassOf } from '../storage/enrich_failures';

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
  // #421: the SECOND eligibility gate (the pools apply the first). Both must read the row's
  // verdict, or the recurring `not_on_untappd` tail dies silently — the pool hands the row
  // over and this gate drops it, with nothing in the logs to say why.
  const recurring = RECURRING_CLASSES.includes(reviewClassOf(deps.db, beerId) ?? '');
  if (!isEligible(now, beer.untappd_lookup_at, beer.untappd_lookup_count, recurring)) {
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
