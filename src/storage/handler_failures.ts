import type { DB } from './db';

// #836: what failed and with which error — never who asked or what they typed.
export const FAILURE_ERROR_MAX = 200;

export interface HandlerFailureGroup {
  source: string;
  error: string;
  count: number;
}

export function recordHandlerFailure(db: DB, f: { at: string; source: string; error: string }): void {
  // Code points, not UTF-16 units: a cut must not leave half a surrogate pair in the status report.
  const error = [...f.error].slice(0, FAILURE_ERROR_MAX).join('');
  db.prepare('INSERT INTO handler_failures (at, source, error) VALUES (?, ?, ?)').run(f.at, f.source, error);
}

// `at` is always Date.toISOString(), so string order is time order.
// Both ends are inclusive. The upper end keeps a row stamped while the host clock ran ahead from
// being counted as «the last 24 hours» day after day until real time catches up with it.
export function handlerFailuresSince(db: DB, sinceIso: string, untilIso: string): HandlerFailureGroup[] {
  return db.prepare(
    `SELECT source, error, COUNT(*) AS count FROM handler_failures
     WHERE at >= ? AND at <= ? GROUP BY source, error ORDER BY count DESC, source, error`,
  ).all(sinceIso, untilIso) as HandlerFailureGroup[];
}

export function pruneHandlerFailures(db: DB, beforeIso: string): void {
  db.prepare('DELETE FROM handler_failures WHERE at < ?').run(beforeIso);
}
