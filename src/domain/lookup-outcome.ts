import type pino from 'pino';
import type { DB } from '../storage/db';
import {
  mergeIntoCanonical,
  recordLookupNotFound,
  recordLookupSuccess,
  recordLookupTransient,
} from '../storage/beers';
import type { LookupOutcome } from './untappd-lookup';

export type EnrichOutcomeKind = 'matched' | 'not_found' | 'transient' | 'skipped' | 'blocked';

// Applies a lookupBeer outcome to a beer row's enrichment/backoff state. Shared by the
// server enrich cron (enrichOneOrphan) and the client-relay /enrich/result endpoint so
// both behave identically: on a UNIQUE clash the found bid is merged into the canonical
// row; a `blocked` outcome records NOTHING (a block must never mutate backoff state).
export function applyLookupOutcome(
  deps: { db: DB; log: pino.Logger },
  beerId: number,
  outcome: LookupOutcome,
  nowIso: string,
): EnrichOutcomeKind {
  switch (outcome.kind) {
    case 'matched':
      try {
        recordLookupSuccess(deps.db, beerId, outcome.result);
        return 'matched';
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
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
      deps.log.warn({ err: outcome.error, beerId }, 'untappd-lookup transient failure');
      recordLookupTransient(deps.db, beerId, nowIso);
      return 'transient';
    case 'blocked':
      return 'blocked';
  }
}
