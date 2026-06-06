import type pino from 'pino';
import type { DB } from '../storage/db';
import { normalizeBrewery } from '../domain/normalize';

export interface BackfillResult {
  updated: number;
}

// One-time, idempotent recompute of the stored normalized_brewery idempotency
// key. Runtime matching recomputes normalizeBrewery live, but the
// (normalized_brewery, normalized_name) upsert key drifts when the normalize
// rules change. idx_beers_norm is non-UNIQUE, so collisions cannot throw.
export function backfillNormalizedBrewery(db: DB, log: pino.Logger): BackfillResult {
  const rows = db
    .prepare('SELECT id, brewery, normalized_brewery FROM beers')
    .all() as Array<{ id: number; brewery: string; normalized_brewery: string }>;
  const update = db.prepare('UPDATE beers SET normalized_brewery = ? WHERE id = ?');
  let updated = 0;

  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      const fresh = normalizeBrewery(r.brewery);
      if (fresh !== r.normalized_brewery) {
        update.run(fresh, r.id);
        updated++;
      }
    }
  });
  tx(rows);

  log.info({ updated }, 'backfill-normalized-brewery done');
  return { updated };
}
