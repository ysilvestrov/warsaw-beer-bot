import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { loadEnv } from '../src/config/env';
import { retireEnrichFailure } from '../src/storage/enrich_failures';
import { isOntapNonBeerTap } from '../src/sources/ontap/non-beer';
import { loadOperatorEnv } from './operator-env';

loadOperatorEnv();

const AUTO_NOTE = 'retired: current non-beer filter rejects';

export interface RetireTarget {
  beer_id: number;
  brewery: string;
  name: string;
  style: string | null;
  review_class: string | null;
}

// Classified orphan failures (review_class set, not yet retired) whose stored
// beer the CURRENT non-beer filter would now reject — the proof of resolution.
export function selectAutoRetireTargets(db: DB): RetireTarget[] {
  const rows = db
    .prepare(
      `SELECT ef.beer_id, b.brewery, b.name, b.style, ef.review_class
         FROM enrich_failures ef
         JOIN beers b ON b.id = ef.beer_id
        WHERE b.untappd_id IS NULL
          AND ef.review_class IS NOT NULL
          AND ef.retired_at IS NULL
        ORDER BY ef.beer_id`,
    )
    .all() as RetireTarget[];
  return rows.filter((r) =>
    isOntapNonBeerTap({ style: r.style, brewery_ref: r.brewery, beer_ref: r.name }),
  );
}

// Escape hatch: exactly the given beer_ids, restricted to existing orphan rows
// not already retired. Unknown / matched / already-retired ids are silently
// dropped here (the CLI warns about the difference).
export function selectIdTargets(db: DB, ids: number[]): RetireTarget[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT ef.beer_id, b.brewery, b.name, b.style, ef.review_class
         FROM enrich_failures ef
         JOIN beers b ON b.id = ef.beer_id
        WHERE b.untappd_id IS NULL
          AND ef.retired_at IS NULL
          AND ef.beer_id IN (${placeholders})
        ORDER BY ef.beer_id`,
    )
    .all(...ids) as RetireTarget[];
}

// Retire all targets in one transaction. Returns the number actually written.
export function applyRetire(db: DB, targets: RetireTarget[], note: string): number {
  const txn = db.transaction((ts: RetireTarget[]) => {
    let n = 0;
    for (const t of ts) {
      if (retireEnrichFailure(db, t.beer_id, note, new Date().toISOString())) n += 1;
    }
    return n;
  });
  return txn(targets);
}

function parseArgs(argv: string[]): { apply: boolean; ids: number[] | null; reason: string | null } {
  const apply = argv.includes('--apply');
  const idsIdx = argv.indexOf('--ids');
  const reasonIdx = argv.indexOf('--reason');
  const ids = idsIdx >= 0
    ? (argv[idsIdx + 1] ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
    : null;
  const reason = reasonIdx >= 0 ? (argv[reasonIdx + 1] ?? null) : null;
  return { apply, ids, reason };
}

function main(argv: string[]): void {
  const { apply, ids, reason } = parseArgs(argv);
  const db = openDb(loadEnv().DATABASE_PATH);
  try {
    let targets: RetireTarget[];
    let note: string;

    if (ids !== null) {
      if (!reason) {
        console.error('Error: --ids requires --reason "<text>".');
        process.exitCode = 1;
        return;
      }
      note = `retired: ${reason}`;
      targets = selectIdTargets(db, ids);
      const found = new Set(targets.map((t) => t.beer_id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) {
        console.warn(`Skipping ${missing.length} id(s) — unknown, already matched, or already retired: ${missing.join(', ')}`);
      }
    } else {
      if (reason) {
        console.error('Error: --reason is only valid with --ids (auto path uses a fixed note).');
        process.exitCode = 1;
        return;
      }
      note = AUTO_NOTE;
      targets = selectAutoRetireTargets(db);
    }

    for (const t of targets) {
      console.log(`#${t.beer_id} [${t.review_class}] ${t.brewery} / ${t.name}${t.style ? ` (style: ${t.style})` : ''}`);
    }

    if (apply) {
      const n = applyRetire(db, targets, note);
      console.log(`Retired ${n} orphan(s). Note: "${note}"`);
    } else {
      console.log(`${targets.length} orphan(s) would be retired (dry-run; pass --apply to write).`);
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
