import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { listLookupCandidates } from '../storage/beers';
import { enrichOneOrphan } from './untappd-enrich';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';

export interface EnrichOrphansResult {
  processed: number;
  matched: number;
  not_found: number;
  transient: number;
  skipped: number;
  blocked: number;
}

export interface EnrichOrphansDeps {
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

const ZERO_RESULT: EnrichOrphansResult = {
  processed: 0, matched: 0, not_found: 0, transient: 0, skipped: 0, blocked: 0,
};

export async function enrichOrphans(
  deps: EnrichOrphansDeps,
): Promise<EnrichOrphansResult> {
  if (deps.lookupEnabled === false) {
    deps.log.info('untappd-lookup disabled (UNTAPPD_LOOKUP_ENABLED=false), skipping enrich-orphans');
    return ZERO_RESULT;
  }

  const limit = deps.limit ?? 20;
  const sleepMs = deps.sleepMs ?? 500;
  const sleep = deps.sleep ?? ((ms: number) =>
    new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const breaker = deps.breaker ?? noopBreaker;

  if (!breaker.canAttempt(now())) {
    deps.log.info('enrich-orphans skipped (untappd circuit open)');
    return { ...ZERO_RESULT };
  }

  const candidates = listLookupCandidates(deps.db, limit, now());
  const result: EnrichOrphansResult = { ...ZERO_RESULT };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const kind = await enrichOneOrphan(
      { db: deps.db, log: deps.log, http: deps.http, now },
      c.id,
    );
    if (kind === 'blocked') {
      breaker.onResult(true, now());
      result.blocked++;
      result.processed++;
      if (breaker.state === 'open') break;
      if (sleepMs > 0 && i < candidates.length - 1) await sleep(sleepMs);
      continue;
    }
    breaker.onResult(false, now());
    result.processed++;
    result[kind]++;

    if (sleepMs > 0 && i < candidates.length - 1) {
      await sleep(sleepMs);
    }
  }

  deps.log.info(result, 'enrich-orphans done');
  return result;
}
