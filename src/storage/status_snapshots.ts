import type { DB } from './db';
import type { Evaluation, SnapshotMetrics, SnapshotRecord } from '../domain/status/types';

// Bumped when SnapshotMetrics changes shape incompatibly; rows of another version are skipped on
// read rather than misread as today's shape.
export const STATUS_SNAPSHOT_VERSION = 1;

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
      return [{ date: r.date, metrics: JSON.parse(r.metrics_json) as SnapshotMetrics }];
    } catch {
      return [];
    }
  });
}

export function pruneStatusSnapshots(db: DB, keepFromDate: string): number {
  return db.prepare('DELETE FROM status_snapshots WHERE date < ?').run(keepFromDate).changes;
}
