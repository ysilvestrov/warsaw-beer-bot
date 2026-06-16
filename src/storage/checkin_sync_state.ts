import type { DB } from './db';

export interface SyncState {
  deepest_max_id: string | null;
  complete: boolean;
}

export function getSyncState(db: DB, telegramId: number): SyncState {
  const row = db
    .prepare('SELECT deepest_max_id, complete FROM checkin_sync_state WHERE telegram_id = ?')
    .get(telegramId) as { deepest_max_id: string | null; complete: number } | undefined;
  if (!row) return { deepest_max_id: null, complete: false };
  return { deepest_max_id: row.deepest_max_id, complete: row.complete === 1 };
}

// max_id is a numeric Untappd cursor; "deepest" = lowest value. We keep the
// minimum of the existing and incoming cursor so a Phase-1 top-up page (a high
// max_id near "now") never rewinds the Phase-2 deep cursor. complete latches on.
export function advanceSyncState(
  db: DB,
  telegramId: number,
  maxId: string | null,
  complete: boolean,
): void {
  const prev = getSyncState(db, telegramId);
  const deepest = deeper(prev.deepest_max_id, maxId);
  db.prepare(
    `INSERT INTO checkin_sync_state (telegram_id, deepest_max_id, complete, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_id) DO UPDATE SET
       deepest_max_id = excluded.deepest_max_id,
       complete = MAX(checkin_sync_state.complete, excluded.complete),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(telegramId, deepest, complete || prev.complete ? 1 : 0);
}

function deeper(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Number(b) < Number(a) ? b : a;
}
