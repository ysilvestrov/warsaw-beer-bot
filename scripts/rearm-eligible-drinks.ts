// One-shot repair for #430: 16 rows classified not_a_beer while being cider, kvass or
// kombucha — every one written by the model between 2026-08-16 and 2026-08-21 under the
// prompt this issue fixes. Enumerated from prod, never re-derived by a LIKE predicate.
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';

const IDS = [
  258, 298, 366, 391, 11966, 11989, 12272, 29906,
  29931, 29940, 30122, 30134, 30135, 31246, 31299, 33659,
];

interface Target {
  beer_id: number;
  brewery: string;
  name: string;
}

function main(argv: string[]): void {
  const path = argv[0];
  if (!path) throw new Error('usage: rearm-eligible-drinks <db-path> [--apply]');
  const apply = argv.includes('--apply');
  const db: DB = openDb(path);
  try {
    const before = db
      .prepare(`SELECT COUNT(*) n FROM enrich_failures WHERE review_class = 'not_a_beer'`)
      .get() as { n: number };
    const untriagedBefore = db
      .prepare(
        `SELECT COUNT(*) n FROM enrich_failures
          WHERE review_class IS NULL AND outcome = 'not_found' AND retired_at IS NULL`,
      )
      .get() as { n: number };
    const targets = db
      .prepare(
        `SELECT beer_id, brewery, name FROM enrich_failures
          WHERE beer_id IN (${IDS.join(',')}) AND review_class = 'not_a_beer'`,
      )
      .all() as Target[];

    console.log(`not_a_beer before: ${before.n}   untriaged before: ${untriagedBefore.n}`);
    console.log(`rows matching the id list AND still not_a_beer: ${targets.length} of ${IDS.length}`);
    for (const t of targets) console.log(' ', t);

    if (!apply) {
      console.log('\nDRY RUN — pass --apply to write');
      return;
    }

    const info = db
      .prepare(
        `UPDATE enrich_failures
            SET review_class = NULL, review_note = NULL, reviewed_at = NULL, issue_number = NULL
          WHERE beer_id IN (${IDS.join(',')}) AND review_class = 'not_a_beer'`,
      )
      .run();
    const after = db
      .prepare(`SELECT COUNT(*) n FROM enrich_failures WHERE review_class = 'not_a_beer'`)
      .get() as { n: number };
    const untriagedAfter = db
      .prepare(
        `SELECT COUNT(*) n FROM enrich_failures
          WHERE review_class IS NULL AND outcome = 'not_found' AND retired_at IS NULL`,
      )
      .get() as { n: number };
    console.log(`updated: ${info.changes}`);
    console.log(`not_a_beer after: ${after.n}   untriaged after: ${untriagedAfter.n}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
