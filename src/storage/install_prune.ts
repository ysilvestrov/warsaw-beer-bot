import type { DB } from './db';

export interface InstallPruneCounts { usage: number; registrations: number; misses: number; installs: number }

// Retention for the #923 tables (spec #923 §2.6): the ledgers keep 90 Warsaw days, an install not
// seen for 180 days is deleted (its usage goes with it by cascade; match_misses are not its rows).
// `*Before` are Warsaw dates; a row dated exactly on the cut-off stays.
export function pruneInstallLedger(
  db: DB,
  args: { ledgerBefore: string; installsBefore: string },
): InstallPruneCounts {
  return db.transaction((): InstallPruneCounts => ({
    installs: db.prepare('DELETE FROM extension_installs WHERE last_seen_date < ?').run(args.installsBefore).changes,
    usage: db.prepare('DELETE FROM install_usage_daily WHERE date < ?').run(args.ledgerBefore).changes,
    registrations: db.prepare('DELETE FROM install_registrations_daily WHERE date < ?').run(args.ledgerBefore).changes,
    misses: db.prepare('DELETE FROM match_misses WHERE last_seen_date < ?').run(args.ledgerBefore).changes,
  }))();
}
