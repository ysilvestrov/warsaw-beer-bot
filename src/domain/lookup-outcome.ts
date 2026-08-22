import type pino from 'pino';
import type { DB } from '../storage/db';
import {
  mergeIntoCanonical,
  recordLookupNotFound,
  recordLookupSuccess,
  recordLookupTransient,
} from '../storage/beers';
import { recordEnrichFailure, clearEnrichFailure, setEnrichFailureReview, reviewClassOf } from '../storage/enrich_failures';
import type { LookupOutcome } from './untappd-lookup';
import { summarizeCandidates } from './candidate-format';
import { classifyOrphanAsNonBeer, SHADOW_ONLY } from './drink-boundary';

export type EnrichOutcomeKind = 'matched' | 'merged' | 'not_found' | 'transient' | 'skipped' | 'blocked';

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
          // CASCADE-removed; this is a success, not a failure. Reported as its own
          // kind so it stops being counted (and answered) as not_found (#351).
          mergeIntoCanonical(deps.db, beerId, canonical.id, nowIso);
          deps.log.warn(
            { beerId, canonicalId: canonical.id, bid: outcome.result.bid },
            'enrich: merged duplicate orphan into canonical',
          );
          return 'merged';
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
      const boundary = classifyOrphanAsNonBeer({
        brewery: input.brewery,
        name: input.name,
        style: null,
        candidates_count: outcome.candidates.length,
      });
      if (boundary) {
        if (SHADOW_ONLY) {
          deps.log.warn(
            { beerId, token: boundary.token, name: input.name, shadow: true },
            'drink-boundary: would classify as not_a_beer',
          );
        } else if (reviewClassOf(deps.db, beerId) !== null) {
          // A row already carrying a verdict (matcher_bug, not_on_untappd, ...) keeps
          // that class across retries — recordEnrichFailure only nulls it on a
          // candidates-count crossing or an unlocked_at settle. Auto-classify must
          // never overwrite a real verdict with the one irreversible one: a row a
          // human/model already triaged is not this function's to reclassify (#430).
          deps.log.warn(
            { beerId, token: boundary.token, name: input.name },
            'drink-boundary: auto-classify skipped, row already has a review_class',
          );
        } else {
          const result = setEnrichFailureReview(
            deps.db, beerId, 'not_a_beer', `auto: ${boundary.token}`, nowIso, null,
          );
          if (result !== 'written') {
            deps.log.warn({ beerId, result }, 'drink-boundary: auto-classify refused');
          }
        }
      }
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
