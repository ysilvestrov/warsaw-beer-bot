import type pino from 'pino';
import type { DB } from '../storage/db';
import { canonicalCheckinAt } from '../domain/checkin-time';

export interface BackfillResult {
  updated: number;
}

// One-time, idempotent normalization of checkins.checkin_at to the canonical
// 'YYYY-MM-DD HH:MM:SS' (UTC) form. The extension feed sync historically stored
// RFC-2822 strings ("Tue, 05 May 2026 21:40:37 +0000") which break lexicographic
// MAX()/ORDER BY (and surfaced as a wrong/garbled date in /status, #190). Only
// rows whose canonical form differs are rewritten, so re-runs are no-ops.
export function backfillCheckinAt(db: DB, log: pino.Logger): BackfillResult {
  const rows = db
    .prepare('SELECT id, checkin_at FROM checkins')
    .all() as Array<{ id: number; checkin_at: string }>;
  const update = db.prepare('UPDATE checkins SET checkin_at = ? WHERE id = ?');
  let updated = 0;

  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      const fresh = canonicalCheckinAt(r.checkin_at);
      if (fresh !== r.checkin_at) {
        update.run(fresh, r.id);
        updated++;
      }
    }
  });
  tx(rows);

  log.info({ updated }, 'backfill-checkin-at done');
  return { updated };
}
