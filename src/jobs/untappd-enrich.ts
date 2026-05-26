import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { isEligible } from '../domain/lookup-backoff';
import { lookupBeer } from '../domain/untappd-lookup';
import {
  getBeer,
  recordLookupSuccess,
  recordLookupNotFound,
  recordLookupTransient,
} from '../storage/beers';

export type EnrichOutcomeKind = 'matched' | 'not_found' | 'transient' | 'skipped';

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
    fetch: (url) => deps.http.get(url),
  });

  const nowIso = now.toISOString();
  switch (outcome.kind) {
    case 'matched':
      recordLookupSuccess(deps.db, beerId, outcome.result);
      return 'matched';
    case 'not_found':
      recordLookupNotFound(deps.db, beerId, nowIso);
      return 'not_found';
    case 'transient':
      deps.log.warn(
        { err: outcome.error, beerId },
        'untappd-lookup transient failure',
      );
      recordLookupTransient(deps.db, beerId, nowIso);
      return 'transient';
  }
}
