import type pino from 'pino';
import type { DB } from '../storage/db';
import {
  mergeIntoCanonical,
  recordLookupNotFound,
  recordLookupSuccess,
  recordLookupTransient,
} from '../storage/beers';
import { recordEnrichFailure, clearEnrichFailure, setEnrichFailureReview, reviewClassOf } from '../storage/enrich_failures';
import { getBeer } from '../storage/beers';
import type { LookupOutcome } from './untappd-lookup';
import { summarizeCandidates } from './candidate-format';
import { classifyOrphanAsNonBeer, autoClassifyAction, SHADOW_ONLY } from './drink-boundary';

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
    case 'not_found': {
      // #430 F4: captured BEFORE recordEnrichFailure runs. recordEnrichFailure
      // intentionally NULLs review_class on a 0<->>0 candidates crossing, to hand the
      // row back to the model for re-triage. If the guard read this column after that
      // call, it would see the row as never-triaged and could seal it not_a_beer
      // before the model ever got the re-triage it was just handed — the opposite of
      // what the clearing is for. Capturing it first means the guard judges the row
      // as it stood coming INTO this call, which is the state auto-classify must
      // respect. The WRITE (setEnrichFailureReview) still has to run after
      // recordEnrichFailure, because it refuses unless the row already exists with
      // outcome='not_found'.
      const currentReviewClass = reviewClassOf(deps.db, beerId);
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
      // #430 F1: read the beer's own stored style rather than discarding it. 329 of
      // 724 orphan rows carry a stored style, and 44 of those name an eligible family
      // (cider/mead/kvass/kombucha) only in the style column — the eligible check is
      // the side this module must be maximally generous on, so a hard-coded null here
      // was silently throwing away a real signal.
      const beerRow = getBeer(deps.db, beerId);
      const boundary = classifyOrphanAsNonBeer({
        brewery: input.brewery,
        name: input.name,
        style: beerRow?.style ?? null,
        candidates_count: outcome.candidates.length,
      });
      if (boundary) {
        switch (autoClassifyAction(true, currentReviewClass, SHADOW_ONLY)) {
          case 'log':
            deps.log.warn(
              { beerId, token: boundary.token, name: input.name, shadow: true },
              'drink-boundary: would classify as not_a_beer',
            );
            break;
          case 'none':
            // Only reachable here via the guard (matched is always true in this
            // branch): a row already carrying the PRE-mutation verdict (matcher_bug,
            // not_on_untappd, ...) keeps it — captured above, before
            // recordEnrichFailure could have nulled it on a candidates-count crossing
            // or an unlocked_at settle. Auto-classify must never overwrite a real
            // verdict with the one irreversible one, live OR shadowed: F3 moved this
            // guard ahead of the shadow branch so shadow logs exactly the set live
            // would write, not a superset. This guard is proved exhaustively by
            // autoClassifyAction's own tests in drink-boundary.test.ts, not here —
            // this file's #430 test only proves the wiring (#430).
            deps.log.warn(
              { beerId, token: boundary.token, name: input.name },
              'drink-boundary: auto-classify skipped, row already has a review_class',
            );
            break;
          case 'write': {
            const result = setEnrichFailureReview(
              deps.db, beerId, 'not_a_beer', `auto: ${boundary.token}`, nowIso, null,
            );
            if (result !== 'written') {
              deps.log.warn({ beerId, result }, 'drink-boundary: auto-classify refused');
            }
            break;
          }
        }
      }
      return 'not_found';
    }
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
