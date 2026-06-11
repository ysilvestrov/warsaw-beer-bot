import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { isEligible } from '../domain/lookup-backoff';
import { lookupBeer } from '../domain/untappd-lookup';
import { applyLookupOutcome } from '../domain/lookup-outcome';
import type { EnrichOutcomeKind } from '../domain/lookup-outcome';
import { getBeer } from '../storage/beers';

export type { EnrichOutcomeKind } from '../domain/lookup-outcome';

export interface EnrichDeps {
  db: DB;
  log: pino.Logger;
  http: Http;
  now?: () => Date;
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

  const outcome = await lookupBeer({
    brewery: beer.brewery,
    name: beer.name,
    abv: beer.abv,
    fetch: (url) => deps.http.get(url),
  });

  const nowIso = now.toISOString();
  return applyLookupOutcome(deps, beerId, outcome, nowIso, { brewery: beer.brewery, name: beer.name });
}
