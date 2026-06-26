import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import {
  listRatingRefreshCandidates,
  recordRatingSuccess,
  recordRatingNotFound,
  recordRatingTransient,
} from '../storage/beers';
import { buildBeerPageUrl, parseBeerPage } from '../sources/untappd/beer-page';
import { HttpError } from '../sources/http';
import { isBlockStatus, isBlockPage } from '../sources/untappd/block';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';

export interface RefreshTapRatingsResult {
  processed: number;
  matched: number;
  not_found: number;
  transient: number;
  blocked: number;
}

export interface RefreshTapRatingsDeps {
  db: DB;
  log: pino.Logger;
  http: Http;
  lookupEnabled?: boolean;     // default true
  limit?: number;               // default 20
  sleepMs?: number;             // default 500
  sleep?: (ms: number) => Promise<void>;   // for tests
  now?: () => Date;             // for tests
  breaker?: CircuitBreaker;     // default noopBreaker
}

const ZERO_RESULT: RefreshTapRatingsResult = {
  processed: 0, matched: 0, not_found: 0, transient: 0, blocked: 0,
};

export async function refreshTapRatings(
  deps: RefreshTapRatingsDeps,
): Promise<RefreshTapRatingsResult> {
  if (deps.lookupEnabled === false) {
    deps.log.info(
      'untappd-lookup disabled (UNTAPPD_LOOKUP_ENABLED=false), skipping refresh-tap-ratings',
    );
    return ZERO_RESULT;
  }

  const limit = deps.limit ?? 20;
  const sleepMs = deps.sleepMs ?? 500;
  const sleep = deps.sleep ?? ((ms: number) =>
    new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const breaker = deps.breaker ?? noopBreaker;

  if (!breaker.canAttempt(now())) {
    deps.log.info('refresh-tap-ratings skipped (untappd circuit open)');
    return { ...ZERO_RESULT };
  }

  const candidates = listRatingRefreshCandidates(deps.db, limit, now());
  const result: RefreshTapRatingsResult = { ...ZERO_RESULT };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const tickNow = now();
    const nowIso = tickNow.toISOString();
    let blocked = false;
    try {
      const html = await deps.http.get(buildBeerPageUrl(c.untappd_id));
      if (isBlockPage(html)) {
        blocked = true;
      } else {
        const { global_rating } = parseBeerPage(html);
        if (global_rating !== null) {
          recordRatingSuccess(deps.db, c.id, global_rating);
          result.matched++;
        } else {
          recordRatingNotFound(deps.db, c.id, nowIso);
          result.not_found++;
        }
      }
    } catch (err) {
      if (err instanceof HttpError && isBlockStatus(err.status)) {
        blocked = true;
      } else {
        deps.log.warn({ err, beerId: c.id, untappdId: c.untappd_id },
          'rating-refresh transient failure');
        recordRatingTransient(deps.db, c.id, nowIso);
        result.transient++;
      }
    }

    if (blocked) {
      breaker.onResult(true, tickNow);
      result.blocked++;
      result.processed++;
      if (breaker.state === 'open') break;
      if (sleepMs > 0 && i < candidates.length - 1) await sleep(sleepMs);
      continue;
    }
    breaker.onResult(false, tickNow);
    result.processed++;

    if (sleepMs > 0 && i < candidates.length - 1) {
      await sleep(sleepMs);
    }
  }

  deps.log.info(result, 'refresh-tap-ratings done');
  return result;
}
