import type { DB } from './db';

export interface HistoryOwner {
  telegramId: number;
  accountKey: string;
  linkRevision: number;
}

export function accountKeyFor(username: string | null): string {
  return username?.toLowerCase() ?? '';
}

export function getHistoryOwner(db: DB, telegramId: number): HistoryOwner {
  const row = db.prepare('SELECT untappd_username, untappd_link_revision FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { untappd_username: string | null; untappd_link_revision: number } | undefined;
  return { telegramId, accountKey: accountKeyFor(row?.untappd_username ?? null), linkRevision: row?.untappd_link_revision ?? 0 };
}

// Call within the same writer transaction as the guarded mutation.
export function isCurrentHistoryOwner(db: DB, owner: HistoryOwner): boolean {
  const current = getHistoryOwner(db, owner.telegramId);
  return current.accountKey === owner.accountKey && current.linkRevision === owner.linkRevision;
}
