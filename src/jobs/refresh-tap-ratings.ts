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

export interface RefreshTapRatingsResult {
  processed: number;
  matched: number;
  not_found: number;
  transient: number;
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
}

const ZERO_RESULT: RefreshTapRatingsResult = {
  processed: 0, matched: 0, not_found: 0, transient: 0,
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

  const candidates = listRatingRefreshCandidates(deps.db, limit, now());
  const result: RefreshTapRatingsResult = { ...ZERO_RESULT };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const tickNow = now();
    const nowIso = tickNow.toISOString();
    try {
      const html = await deps.http.get(buildBeerPageUrl(c.untappd_id));
      const { global_rating } = parseBeerPage(html);
      if (global_rating !== null) {
        recordRatingSuccess(deps.db, c.id, global_rating);
        result.matched++;
      } else {
        recordRatingNotFound(deps.db, c.id, nowIso);
        result.not_found++;
      }
    } catch (err) {
      deps.log.warn({ err, beerId: c.id, untappdId: c.untappd_id },
        'rating-refresh transient failure');
      recordRatingTransient(deps.db, c.id, nowIso);
      result.transient++;
    }
    result.processed++;

    if (sleepMs > 0 && i < candidates.length - 1) {
      await sleep(sleepMs);
    }
  }

  deps.log.info(result, 'refresh-tap-ratings done');
  return result;
}
