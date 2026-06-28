import type pino from 'pino';
import type { DB } from '../storage/db';
import {
  mergeIntoCanonical,
  recordLookupNotFound,
  recordLookupSuccess,
  recordLookupTransient,
} from '../storage/beers';
import { recordEnrichFailure, clearEnrichFailure } from '../storage/enrich_failures';
import type { LookupOutcome } from './untappd-lookup';
import type { SearchResult } from '../sources/untappd/search';

export type EnrichOutcomeKind = 'matched' | 'not_found' | 'transient' | 'skipped' | 'blocked';

// Compact, human-readable summary of what the Untappd search returned — top 3
// "<brewery> — <name>". Empty string when the search returned nothing (a noisy query).
function summarizeCandidates(candidates: SearchResult[]): string {
  return candidates.slice(0, 3).map((r) => `${r.brewery_name} — ${r.beer_name}`).join('; ');
}

// Applies a lookupBeer outcome to a beer row's enrichment/backoff state. Shared by the
// server enrich cron (enrichOneOrphan) and the client-relay /enrich/result endpoint so
// both behave identically: on a UNIQUE clash the found bid is merged into the canonical
// row; a `blocked` outcome records NOTHING (a block must never mutate backoff state).
export function applyLookupOutcome(
  deps: { db: DB; log: pino.Logger },
  beerId: number,
  outcome: LookupOutcome,
  nowIso: string,
  input: { brewery: string; name: string; sourceUrl?: string },
): EnrichOutcomeKind {
  switch (outcome.kind) {
    case 'matched':
      try {
        recordLookupSuccess(deps.db, beerId, outcome.result, nowIso);
        clearEnrichFailure(deps.db, beerId);
        return 'matched';
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
        const canonical = deps.db
          .prepare('SELECT id FROM beers WHERE untappd_id = ?')
          .get(outcome.result.bid) as { id: number } | undefined;
        if (canonical) {
          // mergeIntoCanonical deletes the orphan row → its enrich_failures row is
          // CASCADE-removed; this is a success, not a failure.
          mergeIntoCanonical(deps.db, beerId, canonical.id);
          deps.log.warn(
            { beerId, canonicalId: canonical.id, bid: outcome.result.bid },
            'enrich: merged duplicate orphan into canonical',
          );
        }
        return 'not_found';
      }
    case 'not_found':
      recordEnrichFailure(deps.db, {
        beer_id: beerId,
        brewery: input.brewery,
        name: input.name,
        search_url: outcome.searchUrls[0] ?? '',
        source_url: input.sourceUrl ?? '',
        outcome: 'not_found',
        candidates_count: outcome.candidates.length,
        candidates_summary: summarizeCandidates(outcome.candidates),
        at: nowIso,
      });
      recordLookupNotFound(deps.db, beerId, nowIso);
      return 'not_found';
    case 'transient':
      deps.log.warn({ err: outcome.error, beerId }, 'untappd-lookup transient failure');
      recordLookupTransient(deps.db, beerId, nowIso);
      return 'transient';
    case 'blocked':
      recordEnrichFailure(deps.db, {
        beer_id: beerId,
        brewery: input.brewery,
        name: input.name,
        search_url: outcome.searchUrl,
        source_url: input.sourceUrl ?? '',
        outcome: 'blocked',
        candidates_count: 0,
        candidates_summary: '',
        at: nowIso,
      });
      return 'blocked';
  }
}
