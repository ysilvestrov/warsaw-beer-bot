import type pino from 'pino';
import type { DB } from '../storage/db';
import { normalizeBrewery } from '../domain/normalize';
import { inactiveLegacyOrphanPredicate } from '../storage/beers';

export interface BackfillResult {
  updated: number;
}

// One-time, idempotent recompute of the stored normalized_brewery idempotency
// key. Runtime matching recomputes normalizeBrewery live, but the
// (normalized_brewery, normalized_name) upsert key drifts when the normalize
// rules change. idx_beers_norm is non-UNIQUE, so collisions cannot throw.
export function backfillNormalizedBrewery(db: DB, log: pino.Logger): BackfillResult {
  const rows = db
    .prepare(`SELECT b.id, b.brewery, b.normalized_brewery FROM beers b
      WHERE NOT ${inactiveLegacyOrphanPredicate}`)
    .all() as Array<{ id: number; brewery: string; normalized_brewery: string }>;
  const update = db.prepare(`UPDATE beers SET normalized_brewery = ? WHERE id = ?
    AND NOT EXISTS (SELECT 1 FROM legacy_orphan_dispositions lod
      WHERE lod.beer_id = beers.id AND lod.reopened_at IS NULL)`);
  let updated = 0;

  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      const fresh = normalizeBrewery(r.brewery);
      if (fresh !== r.normalized_brewery) {
        updated += update.run(fresh, r.id).changes;
      }
    }
  });
  tx(rows);

  log.info({ updated }, 'backfill-normalized-brewery done');
  return { updated };
}
