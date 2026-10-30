import type { DB } from './db';

export interface InstallUsageDelta {
  date: string;
  installId: string;
  shop: string;
  matchRequests?: number;
  matchBeers?: number;
  matchMisses?: number;
}

// Best-effort per-request increment of one install's counters (spec #923 §1.2). Runs on the /match
// hot path, so it uses the same busy_timeout = 0 window as recordMatchUsage: a contended write fails
// fast (the caller swallows it → a dropped count) instead of stalling the event loop for up to 5 s.
export function recordInstallUsage(db: DB, d: InstallUsageDelta): void {
  const prevBusyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try {
    db.prepare(`
      INSERT INTO install_usage_daily (date, install_id, shop, match_requests, match_beers, match_misses)
      VALUES (@date, @installId, @shop, @matchRequests, @matchBeers, @matchMisses)
      ON CONFLICT(date, install_id, shop) DO UPDATE SET
        match_requests = match_requests + excluded.match_requests,
        match_beers    = match_beers    + excluded.match_beers,
        match_misses   = match_misses   + excluded.match_misses
    `).run({
      date: d.date,
      installId: d.installId,
      shop: d.shop,
      matchRequests: d.matchRequests ?? 0,
      matchBeers: d.matchBeers ?? 0,
      matchMisses: d.matchMisses ?? 0,
    });
  } finally {
    db.pragma(`busy_timeout = ${prevBusyTimeout}`);
  }
}
