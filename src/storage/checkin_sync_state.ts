import type { DB } from './db';

export interface SyncState {
  deepest_max_id: string | null;
  complete: boolean;
  profile_total: number | null;
}

export function getSyncState(db: DB, telegramId: number): SyncState {
  const row = db
    .prepare(
      'SELECT deepest_max_id, complete, profile_total FROM checkin_sync_state WHERE telegram_id = ?',
    )
    .get(telegramId) as
    | { deepest_max_id: string | null; complete: number; profile_total: number | null }
    | undefined;
  if (!row) return { deepest_max_id: null, complete: false, profile_total: null };
  return {
    deepest_max_id: row.deepest_max_id,
    complete: row.complete === 1,
    profile_total: row.profile_total,
  };
}

// max_id is a numeric Untappd cursor; "deepest" = lowest value. We keep the
// minimum of the existing and incoming cursor so a Phase-1 top-up page (a high
// max_id near "now") never rewinds the Phase-2 deep cursor. complete latches on.
// profile_total: latest non-null wins — COALESCE keeps the prior value when the
// incoming page parsed no total.
export function advanceSyncState(
  db: DB,
  telegramId: number,
  maxId: string | null,
  complete: boolean,
  profileTotal: number | null = null,
): void {
  const prev = getSyncState(db, telegramId);
  const deepest = deeper(prev.deepest_max_id, maxId);
  db.prepare(
    `INSERT INTO checkin_sync_state (telegram_id, deepest_max_id, complete, profile_total, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_id) DO UPDATE SET
       deepest_max_id = excluded.deepest_max_id,
       complete = MAX(checkin_sync_state.complete, excluded.complete),
       profile_total = COALESCE(excluded.profile_total, checkin_sync_state.profile_total),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(telegramId, deepest, complete || prev.complete ? 1 : 0, profileTotal);
}

function deeper(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Number(b) < Number(a) ? b : a;
}
