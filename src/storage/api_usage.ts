import type { DB } from './db';

export interface DailyUsage {
  anonRequests: number;
  authedRequests: number;
  beers: number;
}

// Best-effort per-request increment for one accepted /match call. Caller passes
// the Warsaw date, whether the caller was authenticated, and the requested beer
// count. One aggregate row per date (UPSERT), so growth is bounded.
export function recordMatchUsage(
  db: DB, args: { date: string; authed: boolean; beers: number },
): void {
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
