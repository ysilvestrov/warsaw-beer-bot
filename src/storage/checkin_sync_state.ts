import type { DB } from './db';
import { getHistoryOwner } from './history-owner';
import { deepestCoveredId } from './checkin_coverage';

export interface SyncState {
  deepest_max_id: string | null;
  /** #587: застаріле. Ніхто більше не пише — дно стрічки недоказове (див. спеку). */
  complete: boolean;
  profile_total: number | null;
  updated_at: string | null;
}

// #587: курсор більше не зберігається окремо. Він ПОХІДНИЙ від покриття — найглибший
// доведений id, — тож не існує місця, де можна було б ствердити глибину, якої не досягли.
export function getSyncState(db: DB, telegramId: number, accountKey?: string): SyncState {
  // Keep the active owner and all constituent reads in one WAL snapshot.
  return db.transaction(() => {
    const row = db
      .prepare('SELECT complete, profile_total, updated_at FROM checkin_sync_state WHERE telegram_id = ? AND account_key = ?')
      .get(telegramId, accountKey ?? getHistoryOwner(db, telegramId).accountKey) as { complete: number; profile_total: number | null; updated_at: string } | undefined;
    const deepest = deepestCoveredId(db, telegramId, accountKey);
    return {
      deepest_max_id: deepest === null ? null : String(deepest),
      complete: row?.complete === 1,
      profile_total: row?.profile_total ?? null,
      updated_at: row?.updated_at ?? null,
    };
  })();
}

// Єдине, що ще пишеться в цю таблицю: останній відомий лік чекінів у профілі Untappd.
// COALESCE — щоб сторінка-фрагмент (у якої статистики немає) не стирала значення.
export function recordProfileTotal(db: DB, telegramId: number, profileTotal: number | null, accountKey?: string): void {
  db.prepare(
    `INSERT INTO checkin_sync_state (telegram_id, account_key, deepest_max_id, complete, profile_total, updated_at)
       VALUES (?, ?, NULL, 0, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_id, account_key) DO UPDATE SET
       profile_total = COALESCE(excluded.profile_total, checkin_sync_state.profile_total),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(telegramId, accountKey ?? getHistoryOwner(db, telegramId).accountKey, profileTotal);
}
