import type { DB } from './db';
import type { Evaluation, SnapshotMetrics, SnapshotRecord } from '../domain/status/types';

// Bumped when SnapshotMetrics changes shape incompatibly; rows of another version are skipped on
// read rather than misread as today's shape.
export const STATUS_SNAPSHOT_VERSION = 1;

// Every field of SnapshotMetrics the rules and trends read, by the type it must have. The
// compile-time guard below fails typecheck when a field is added to StatusMetrics without being
// listed here, so a new metric cannot silently stay unchecked.
const NUMBER_KEYS = [
  'pubsScraped24h', 'beersTotal', 'beersMatched', 'orphansPending', 'orphansRelayQueue',
  'ratingsMissing', 'ratingsChecked30d', 'snapshots', 'taps', 'usersTotal', 'usersLinked',
  'onTapDistinct', 'onTapPubs', 'newOnTap24h', 'enrichMatched24h', 'enrichFailures24h',
  'extMatchRequests', 'extMatchAnon', 'extMatchBeers', 'mcpMatchRequests', 'mcpMatchBeers',
  'sealUnidentifiable', 'sealUnidentifiableReobserved', 'sealNotABeer', 'sealNotABeer7d',
  'sealRetiredFalsified', 'lockedRows', 'unlocked7d', 'verdictsOutlived7d', 'unrescuedRows',
  'unlockedUnadjudicated7d',
] as const satisfies readonly (keyof SnapshotMetrics)[];
const NULLABLE_NUMBER_KEYS = [
  'lastScrapeHoursAgo', 'dbSizeMb', 'diskBytesAvailable', 'inodesFree',
] as const satisfies readonly (keyof SnapshotMetrics)[];
const BOOLEAN_KEYS = ['untappdSearchHealthy'] as const satisfies readonly (keyof SnapshotMetrics)[];

type ListedKey = (typeof NUMBER_KEYS | typeof NULLABLE_NUMBER_KEYS | typeof BOOLEAN_KEYS)[number];
type Unlisted = Exclude<keyof SnapshotMetrics, ListedKey>;
// Fails to compile ("not assignable to never") if a SnapshotMetrics field is not listed above.
const ALL_METRICS_LISTED: [Unlisted] extends [never] ? true : never = true;
void ALL_METRICS_LISTED;

const isFiniteNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

function hasMetricsShape(m: object): m is SnapshotMetrics {
  const r = m as Record<string, unknown>;
  return NUMBER_KEYS.every((k) => isFiniteNumber(r[k]))
    && NULLABLE_NUMBER_KEYS.every((k) => r[k] === null || isFiniteNumber(r[k]))
    && BOOLEAN_KEYS.every((k) => typeof r[k] === 'boolean');
}

export function saveStatusSnapshot(
  db: DB,
  s: { date: string; metrics: SnapshotMetrics; colours: Evaluation[]; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO status_snapshots (date, version, metrics_json, colours_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       version = excluded.version, metrics_json = excluded.metrics_json,
       colours_json = excluded.colours_json, created_at = excluded.created_at`,
  ).run(s.date, STATUS_SNAPSHOT_VERSION, JSON.stringify(s.metrics), JSON.stringify(s.colours), s.createdAt);
}

// Snapshots with fromDate <= date < beforeDate, oldest first. A row that cannot be parsed is
// skipped: one corrupt day must cost one day of history, not the whole report.
export function listStatusSnapshots(db: DB, fromDate: string, beforeDate: string): SnapshotRecord[] {
  const rows = db.prepare(
    `SELECT date, metrics_json FROM status_snapshots
      WHERE date >= ? AND date < ? AND version = ? ORDER BY date`,
  ).all(fromDate, beforeDate, STATUS_SNAPSHOT_VERSION) as { date: string; metrics_json: string }[];
  return rows.flatMap((r) => {
    try {
      const m: unknown = JSON.parse(r.metrics_json);
      return typeof m === 'object' && m !== null && !Array.isArray(m) && hasMetricsShape(m)
        ? [{ date: r.date, metrics: m }]
        : [];
    } catch {
      return [];
    }
  });
}

export function pruneStatusSnapshots(db: DB, keepFromDate: string): number {
  return db.prepare('DELETE FROM status_snapshots WHERE date < ?').run(keepFromDate).changes;
}
