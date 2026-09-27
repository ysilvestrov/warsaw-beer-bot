import type { Draft } from '../domain/bug-report-flow';
import type { DB } from './db';

interface DraftRow {
  step: Draft['step'];
  source: Draft['source'];
  category: Draft['category'];
  text: string | null;
  media_json: string;
  updated_at: string;
}

export function getDraft(db: DB, telegramId: number): Draft | null {
  const row = db.prepare('SELECT * FROM bug_report_drafts WHERE telegram_id = ?')
    .get(telegramId) as DraftRow | undefined;
  if (!row) return null;
  return {
    step: row.step, source: row.source, category: row.category, text: row.text,
    media: JSON.parse(row.media_json) as Draft['media'], updatedAt: row.updated_at,
  };
}

export function saveDraft(db: DB, telegramId: number, d: Draft): void {
  db.prepare(`INSERT INTO bug_report_drafts
    (telegram_id, step, source, category, text, media_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      step = excluded.step, source = excluded.source, category = excluded.category,
      text = excluded.text, media_json = excluded.media_json, updated_at = excluded.updated_at`)
    .run(telegramId, d.step, d.source, d.category, d.text, JSON.stringify(d.media), d.updatedAt);
}

export function deleteDraft(db: DB, telegramId: number): void {
  db.prepare('DELETE FROM bug_report_drafts WHERE telegram_id = ?').run(telegramId);
}

export function isBanned(db: DB, telegramId: number): boolean {
  return db.prepare('SELECT 1 FROM bug_report_bans WHERE telegram_id = ?').get(telegramId) !== undefined;
}

export function setBan(db: DB, telegramId: number, bannedAt: string): void {
  db.prepare('INSERT OR IGNORE INTO bug_report_bans (telegram_id, banned_at) VALUES (?, ?)')
    .run(telegramId, bannedAt);
}

export function clearBan(db: DB, telegramId: number): void {
  db.prepare('DELETE FROM bug_report_bans WHERE telegram_id = ?').run(telegramId);
}
