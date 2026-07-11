import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { loadEnv } from '../src/config/env';
import { hasCuratedAlias } from '../src/domain/matcher';
import { loadOperatorEnv } from './operator-env';

loadOperatorEnv();

export interface RearmTarget {
  id: number;
  brewery: string;
  name: string;
  untappd_lookup_count: number;
}

// Orphans (no Untappd match) that have already been attempted (count > 0) and whose
// brewery is covered by the curated alias layer. Untried (count = 0) orphans are
// already eligible for the cron, so they are intentionally excluded.
export function selectRearmTargets(db: DB): RearmTarget[] {
  const rows = db
    .prepare(
      `SELECT id, brewery, name, untappd_lookup_count
         FROM beers
        WHERE untappd_id IS NULL AND untappd_lookup_count > 0`,
    )
    .all() as RearmTarget[];
  return rows.filter((r) => hasCuratedAlias(r.brewery));
}

// Reset the lookup-backoff state so the enrich cron re-attempts these beers.
// Returns the number of targets re-armed. Runs in a single transaction.
export function applyRearm(db: DB, targets: RearmTarget[]): number {
  const upd = db.prepare(
    `UPDATE beers SET untappd_lookup_count = 0, untappd_lookup_at = NULL WHERE id = ?`,
  );
  const txn = db.transaction((ts: RearmTarget[]) => {
    for (const t of ts) upd.run(t.id);
    return ts.length;
  });
  return txn(targets);
}

function main(argv: string[]): void {
  const apply = argv.includes('--apply');
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    const targets = selectRearmTargets(db);
    for (const t of targets) {
      console.log(`${t.brewery} / ${t.name} (count=${t.untappd_lookup_count})`);
    }
    if (apply) {
      const n = applyRearm(db, targets);
      console.log(`Re-armed ${n} orphan(s).`);
    } else {
      console.log(
        `${targets.length} orphan(s) would be re-armed (dry-run; pass --apply to write).`,
      );
    }
  } finally {
    db.close();
  }
}

// Run only when invoked directly, not when imported by the test.
if (require.main === module) {
  main(process.argv.slice(2));
}
