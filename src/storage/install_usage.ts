import type { DB } from './db';

export interface InstallUsageDelta {
  date: string;
  installId: string;
  shop: string;
  matchRequests?: number;
  matchBeers?: number;
  matchMisses?: number;
  /** #923 §2.5: an accepted /enrich/result (counted before hydration — the daily limit counts these). */
  enrichResults?: number;
  /** An /enrich/result that answered `matched`. */
  enrichLinks?: number;
  /** An /enrich/result refused with 429 at the daily limit. */
  enrichRejected?: number;
}

// Best-effort per-request increment of one install's counters (spec #923 §1.2). Runs on the /match
// hot path, so it uses the same busy_timeout = 0 window as recordMatchUsage: a contended write fails
// fast (the caller swallows it → a dropped count) instead of stalling the event loop for up to 5 s.
export function recordInstallUsage(db: DB, d: InstallUsageDelta): void {
  const prevBusyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try {
    db.prepare(`
      INSERT INTO install_usage_daily
        (date, install_id, shop, match_requests, match_beers, match_misses,
         enrich_results, enrich_links, enrich_rejected)
      VALUES (@date, @installId, @shop, @matchRequests, @matchBeers, @matchMisses,
              @enrichResults, @enrichLinks, @enrichRejected)
      ON CONFLICT(date, install_id, shop) DO UPDATE SET
        match_requests  = match_requests  + excluded.match_requests,
        match_beers     = match_beers     + excluded.match_beers,
        match_misses    = match_misses    + excluded.match_misses,
        enrich_results  = enrich_results  + excluded.enrich_results,
        enrich_links    = enrich_links    + excluded.enrich_links,
        enrich_rejected = enrich_rejected + excluded.enrich_rejected
    `).run({
      date: d.date,
      installId: d.installId,
      shop: d.shop,
      matchRequests: d.matchRequests ?? 0,
      matchBeers: d.matchBeers ?? 0,
      matchMisses: d.matchMisses ?? 0,
      enrichResults: d.enrichResults ?? 0,
      enrichLinks: d.enrichLinks ?? 0,
      enrichRejected: d.enrichRejected ?? 0,
    });
  } finally {
    db.pragma(`busy_timeout = ${prevBusyTimeout}`);
  }
}

export const ENRICH_RESULTS_PER_INSTALL_PER_DAY = 200;

/**
 * #923 §2.5: takes one of an install's daily /enrich/result slots, or refuses at the limit. The limit
 * counts accepted calls across every shop on the Warsaw date; the read and the increment are one
 * transaction, so two calls cannot both take the last slot. A refusal is counted in enrich_rejected
 * (the digest's "уперлись у 200"). Throws on a contended database — the caller cannot enforce the
 * limit without the count, so it must not proceed.
 */
export function claimInstallEnrich(
  db: DB,
  args: { date: string; installId: string; shop: string },
): 'ok' | 'capped' {
  return db.transaction((): 'ok' | 'capped' => {
    const { n } = db.prepare(
      'SELECT COALESCE(SUM(enrich_results), 0) AS n FROM install_usage_daily WHERE install_id = ? AND date = ?',
    ).get(args.installId, args.date) as { n: number };
    const capped = n >= ENRICH_RESULTS_PER_INSTALL_PER_DAY;
    recordInstallUsage(db, { ...args, ...(capped ? { enrichRejected: 1 } : { enrichResults: 1 }) });
    return capped ? 'capped' : 'ok';
  }).immediate();
}
