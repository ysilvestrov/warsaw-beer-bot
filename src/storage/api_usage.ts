import type { DB } from './db';

export interface DailyUsage {
  anonRequests: number;
  authedRequests: number;
  beers: number;
}

// Best-effort per-request increment for one accepted /match call. Caller passes
// the Warsaw date, whether the caller was authenticated, and the requested beer
// count. One aggregate row per date (UPSERT), so growth is bounded.
//
// This runs on the /match hot path (previously read-only). To keep it from
// stalling the single event loop when another writer (e.g. refreshOntap) holds
// the WAL write lock, we drop busy_timeout to 0 for just this write: a contended
// increment fails fast with SQLITE_BUSY (the caller swallows it → warn, a dropped
// count) instead of blocking up to the connection's 5s timeout. The original
// timeout is restored in finally so every other writer keeps its full tolerance.
// better-sqlite3 is synchronous, so no other statement runs during the window.
export function recordMatchUsage(
  db: DB, args: { date: string; authed: boolean; beers: number },
): void {
  const prevBusyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try {
    db.prepare(`
      INSERT INTO api_usage (date, anon_requests, authed_requests, beers)
      VALUES (@date, @anon, @authed, @beers)
      ON CONFLICT(date) DO UPDATE SET
        anon_requests   = anon_requests   + excluded.anon_requests,
        authed_requests = authed_requests + excluded.authed_requests,
        beers           = beers           + excluded.beers
    `).run({
      date: args.date,
      anon: args.authed ? 0 : 1,
      authed: args.authed ? 1 : 0,
      beers: args.beers,
    });
  } finally {
    db.pragma(`busy_timeout = ${prevBusyTimeout}`);
  }
}

export function getUsageForDate(db: DB, date: string): DailyUsage {
  const row = db.prepare(
    'SELECT anon_requests, authed_requests, beers FROM api_usage WHERE date = ?',
  ).get(date) as { anon_requests: number; authed_requests: number; beers: number } | undefined;
  return {
    anonRequests: row?.anon_requests ?? 0,
    authedRequests: row?.authed_requests ?? 0,
    beers: row?.beers ?? 0,
  };
}
