import type { DB } from './db';
import type { Locale } from '../i18n/types';
import { toLocale } from './user_profiles';

export interface AnnounceRecipient {
  telegramId: number;
  language: Locale | null;
}

/**
 * Token holders who have not opted out (#379). Only token holders: a store install is
 * anonymous, so a user without a token does not exist as far as the bot is concerned.
 *
 * LEFT JOIN rather than INNER: the FK makes a token without a profile impossible today,
 * but if one ever existed, dropping it silently from the list would be worse than
 * sending in the default language.
 */
export function announceRecipients(db: DB): AnnounceRecipient[] {
  const rows = db
    .prepare(
      `SELECT t.telegram_id AS telegram_id, p.language AS language
         FROM api_tokens t
         LEFT JOIN user_profiles p ON p.telegram_id = t.telegram_id
        WHERE COALESCE(p.announce_opt_out, 0) = 0
        ORDER BY t.telegram_id`,
    )
    .all() as { telegram_id: number; language: string | null }[];
  return rows.map((r) => ({ telegramId: r.telegram_id, language: toLocale(r.language) }));
}

export function getAnnounceOptOut(db: DB, telegramId: number): boolean {
  const row = db
    .prepare('SELECT announce_opt_out FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { announce_opt_out: number } | undefined;
  return row?.announce_opt_out === 1;
}

/**
 * Precondition: a `user_profiles` row for `telegramId` must already exist (every
 * caller runs `ensureProfile` first). This is a bare `UPDATE` — zero rows changed is
 * indistinguishable from success, so calling it before the profile exists silently
 * no-ops.
 */
export function setAnnounceOptOut(db: DB, telegramId: number, optOut: boolean): void {
  db.prepare('UPDATE user_profiles SET announce_opt_out = ? WHERE telegram_id = ?')
    .run(optOut ? 1 : 0, telegramId);
}
