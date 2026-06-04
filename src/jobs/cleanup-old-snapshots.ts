import type pino from 'pino';
import type { DB } from '../storage/db';
import { deleteOldSnapshots } from '../storage/snapshots';

// Deletes tap_snapshots (and cascaded taps) older than retentionDays, while
// always keeping each pub's latest snapshot. `now` is injectable for tests.
// Synchronous: the caller's cron wrapper guards it with try/catch.
export function cleanupOldSnapshots(
  db: DB,
  log: pino.Logger,
  retentionDays: number,
  now: () => Date = () => new Date(),
): number {
  const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const deleted = deleteOldSnapshots(db, cutoffIso);
  log.info({ deleted, retentionDays, cutoff: cutoffIso }, 'cleanup-old-snapshots');
  return deleted;
}
