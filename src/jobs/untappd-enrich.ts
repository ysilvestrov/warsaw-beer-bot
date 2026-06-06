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
  mergeIntoCanonical,
} from '../storage/beers';

export type EnrichOutcomeKind = 'matched' | 'not_found' | 'transient' | 'skipped' | 'blocked';

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
  switch (outcome.kind) {
    case 'matched':
      try {
        recordLookupSuccess(deps.db, beerId, outcome.result);
        return 'matched';
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
        // The found untappd_id already belongs to another catalog entry.
        // Redirect match_links to that canonical row and delete this orphan.
        const canonical = deps.db
          .prepare('SELECT id FROM beers WHERE untappd_id = ?')
          .get(outcome.result.bid) as { id: number } | undefined;
        if (canonical) {
          mergeIntoCanonical(deps.db, beerId, canonical.id);
          deps.log.warn(
            { beerId, canonicalId: canonical.id, bid: outcome.result.bid },
            'enrich: merged duplicate orphan into canonical',
          );
        }
        return 'not_found';
      }
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
    case 'blocked':
      // Untappd is blocking us (403/429/captcha). Record NOTHING — a block must
      // never mutate backoff state. The caller's circuit breaker handles it.
      return 'blocked';
  }
}
