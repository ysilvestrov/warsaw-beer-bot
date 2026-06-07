import { createHash } from 'crypto';
import type { DB } from './db';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// 1:1 rotation: drop any existing token for this user, then insert the new one.
export function rotateToken(
  db: DB,
  telegramId: number,
  tokenHash: string,
  at: string,
): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM api_tokens WHERE telegram_id = ?').run(telegramId);
    db.prepare(
      'INSERT INTO api_tokens (token_hash, telegram_id, created_at) VALUES (?, ?, ?)',
    ).run(tokenHash, telegramId, at);
  });
  tx();
}

export function findTelegramIdByHash(db: DB, tokenHash: string): number | null {
  const row = db
    .prepare('SELECT telegram_id FROM api_tokens WHERE token_hash = ?')
    .get(tokenHash) as { telegram_id: number } | undefined;
  return row ? row.telegram_id : null;
}
