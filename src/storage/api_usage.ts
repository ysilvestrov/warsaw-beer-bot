import type { DB } from './db';

export interface DailyUsage {
  anonRequests: number;
  authedRequests: number;
  beers: number;
  mcpRequests: number;
  mcpBeers: number;
}

/**
 * Which surface produced the call. The two are counted apart on purpose: §3.16 declares
 * `anon_requests`/`authed_requests` the extension's traffic, and the digest line says so
 * out loud. A shared counter would keep the claim while quietly changing what it counts.
 */
export type UsageChannel = 'extension' | 'mcp';

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
  db: DB,
  args: { date: string; authed: boolean; beers: number; channel: UsageChannel },
): void {
  const prevBusyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try {
    // `authed` is meaningless for the MCP channel — that surface has no anonymous path at
    // all — so it is deliberately not folded into the MCP counters.
    const mcp = args.channel === 'mcp';
    db.prepare(`
      INSERT INTO api_usage (date, anon_requests, authed_requests, beers, mcp_requests, mcp_beers)
      VALUES (@date, @anon, @authed, @beers, @mcpRequests, @mcpBeers)
      ON CONFLICT(date) DO UPDATE SET
        anon_requests   = anon_requests   + excluded.anon_requests,
        authed_requests = authed_requests + excluded.authed_requests,
        beers           = beers           + excluded.beers,
        mcp_requests    = mcp_requests    + excluded.mcp_requests,
        mcp_beers       = mcp_beers       + excluded.mcp_beers
    `).run({
      date: args.date,
      anon: mcp ? 0 : (args.authed ? 0 : 1),
      authed: mcp ? 0 : (args.authed ? 1 : 0),
      beers: mcp ? 0 : args.beers,
      mcpRequests: mcp ? 1 : 0,
      mcpBeers: mcp ? args.beers : 0,
    });
  } finally {
    db.pragma(`busy_timeout = ${prevBusyTimeout}`);
  }
}

export function getUsageForDate(db: DB, date: string): DailyUsage {
  const row = db.prepare(
    `SELECT anon_requests, authed_requests, beers, mcp_requests, mcp_beers
       FROM api_usage WHERE date = ?`,
  ).get(date) as {
    anon_requests: number; authed_requests: number; beers: number;
    mcp_requests: number; mcp_beers: number;
  } | undefined;
  return {
    anonRequests: row?.anon_requests ?? 0,
    authedRequests: row?.authed_requests ?? 0,
    beers: row?.beers ?? 0,
    mcpRequests: row?.mcp_requests ?? 0,
    mcpBeers: row?.mcp_beers ?? 0,
  };
}
