import type pino from 'pino';
import type { DB } from '../storage/db';
import type { HydratedBeer } from '../sources/untappd/search';
import { listRatingHydrationCandidates, applyHydratedRatings } from '../storage/beers';
import { HttpError } from '../sources/http';
import { isBlockStatus } from '../sources/untappd/block';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';

// #616: звірка рейтингів злінкованого пива з Untappd через Algolia getObjects за bid. Замінює
// refreshTapRatings (HTML-сторінки пива лише для пива на кранах). Межа Algolia — 1000 objectID на
// запит, тож запуск — рівно один запит.
export const RATING_HYDRATION_BATCH = 1000;

export interface HydrateRatingsResult {
  candidates: number;
  updated: number;
  changed: number;
  unknown: number;
  blocked: boolean;
  failed: boolean;
}

export interface HydrateRatingsDeps {
  db: DB;
  log: pino.Logger;
  hydrateByBid: (bids: number[]) => Promise<Map<number, HydratedBeer>>;
  lookupEnabled?: boolean;      // default true
  limit?: number;               // default RATING_HYDRATION_BATCH, ніколи не більше
  now?: () => Date;             // for tests
  breaker?: CircuitBreaker;     // default noopBreaker; обв'язка передає algoliaBreaker
}

const EMPTY: HydrateRatingsResult = {
  candidates: 0, updated: 0, changed: 0, unknown: 0, blocked: false, failed: false,
};

export async function hydrateRatings(deps: HydrateRatingsDeps): Promise<HydrateRatingsResult> {
  if (deps.lookupEnabled === false) {
    deps.log.info('untappd-lookup disabled (UNTAPPD_LOOKUP_ENABLED=false), skipping hydrate-ratings');
    return { ...EMPTY };
  }
  const now = deps.now ?? (() => new Date());
  const breaker = deps.breaker ?? noopBreaker;
  const tickNow = now();
  if (!breaker.canAttempt(tickNow)) {
    deps.log.info('hydrate-ratings skipped (algolia circuit open)');
    return { ...EMPTY };
  }

  const limit = Math.min(deps.limit ?? RATING_HYDRATION_BATCH, RATING_HYDRATION_BATCH);
  const candidates = listRatingHydrationCandidates(deps.db, limit, tickNow);
  if (candidates.length === 0) {
    deps.log.info({ ...EMPTY }, 'hydrate-ratings done');
    return { ...EMPTY };
  }
  const bids = candidates.map((c) => c.untappd_id);

  let hits: Map<number, HydratedBeer>;
  try {
    hits = await deps.hydrateByBid(bids);
  } catch (err) {
    // Блок (після оновлення ключа й проксі в withRecovery) — сигнал breaker'у; інше (5xx, мережа)
    // нічого не каже про блокування. В обох випадках рядки не чіпаються: ні штампа, ні бекофу —
    // наступний запуск просто повторить.
    if (err instanceof HttpError && isBlockStatus(err.status)) {
      breaker.onResult(true, tickNow);
      const res = { ...EMPTY, candidates: candidates.length, blocked: true };
      deps.log.warn({ err, ...res }, 'hydrate-ratings blocked');
      return res;
    }
    const res = { ...EMPTY, candidates: candidates.length, failed: true };
    deps.log.warn({ err, ...res }, 'hydrate-ratings transient failure');
    return res;
  }
  breaker.onResult(false, tickNow);

  const outcome = applyHydratedRatings(deps.db, hits, bids, now().toISOString());
  const res: HydrateRatingsResult = { ...EMPTY, candidates: candidates.length, ...outcome };
  deps.log.info(res, 'hydrate-ratings done');
  return res;
}
