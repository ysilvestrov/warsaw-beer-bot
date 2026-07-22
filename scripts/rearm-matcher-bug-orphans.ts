import { loadEnv } from '../src/config/env';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import type { RearmTarget } from './rearm-aliased-orphans';
import { applyRearm, selectRearmTargetsByIds } from './rearm-aliased-orphans';
import { loadOperatorEnv } from './operator-env';

loadOperatorEnv();

export { applyRearm, selectRearmTargetsByIds } from './rearm-aliased-orphans';

export function selectRearmTargets(db: DB): RearmTarget[] {
  return db
    .prepare(
      `SELECT b.id, b.brewery, b.name, b.untappd_lookup_count
         FROM beers b
         JOIN enrich_failures ef ON ef.beer_id = b.id
        WHERE b.untappd_id IS NULL
          AND b.untappd_lookup_count > 0
          AND ef.review_class = 'matcher_bug'
          AND ef.candidates_count > 0
        ORDER BY b.id`,
    )
    .all() as RearmTarget[];
}

function parseIds(argv: string[]): number[] | null {
  const idx = argv.indexOf('--ids');
  if (idx < 0) return null;
  return (argv[idx + 1] ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
}

function main(argv: string[]): void {
  const apply = argv.includes('--apply');
  const ids = parseIds(argv);
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    let targets: RearmTarget[];
    if (ids !== null) {
      targets = selectRearmTargetsByIds(db, ids);
      const found = new Set(targets.map((t) => t.id));
      for (const id of ids) {
        if (!found.has(id)) {
          console.warn(`⚠ ${id}: skipped (missing or already matched)`);
        }
      }
    } else {
      targets = selectRearmTargets(db);
    }

    for (const target of targets) {
      console.log(
        `${target.brewery} / ${target.name} (count=${target.untappd_lookup_count})`,
      );
    }

    if (apply) {
      const count = applyRearm(db, targets);
      console.log(`Re-armed ${count} matcher-bug orphan(s).`);
    } else {
      console.log(
        `${targets.length} matcher-bug orphan(s) would be re-armed (dry-run; pass --apply to write).`,
      );
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
