import type { DB } from './db';
import type { Locale } from '../i18n/types';
import { OUTSIDE_CITY, isSelectableCity } from '../domain/cities';
import { accountKeyFor } from './history-owner';

export interface ProfileRow {
  telegram_id: number;
  untappd_username: string | null;
  untappd_link_revision: number;
  legacy_sync_revision: number | null;
  language: string | null;
  city: string | null;
  created_at: string;
}

export function ensureProfile(db: DB, telegramId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO user_profiles (telegram_id) VALUES (?)',
  ).run(telegramId);
}

export function setUntappdUsername(db: DB, telegramId: number, username: string): void {
  db.transaction(() => {
    const previous = getProfile(db, telegramId);
    if (!previous) return;
    const key = accountKeyFor(username);
    if (accountKeyFor(previous.untappd_username) !== key) {
      const firstLink = previous.untappd_username === null;
      if (firstLink) {
        // Explicit first linking attributes pre-link imports. Keep named facts
        // on collisions, and retain row IDs for non-colliding imported check-ins.
        db.prepare(`UPDATE checkins AS named SET
          beer_id = COALESCE(named.beer_id, unbound.beer_id),
          user_rating = COALESCE(named.user_rating, unbound.user_rating),
          venue = COALESCE(named.venue, unbound.venue)
          FROM checkins AS unbound
          WHERE named.telegram_id = ? AND named.account_key = ?
            AND unbound.telegram_id = named.telegram_id AND unbound.account_key = ''
            AND unbound.checkin_id = named.checkin_id`).run(telegramId, key);
        db.prepare(`DELETE FROM checkins WHERE telegram_id = ? AND account_key = ''
          AND EXISTS(SELECT 1 FROM checkins named WHERE named.telegram_id = checkins.telegram_id
            AND named.account_key = ? AND named.checkin_id = checkins.checkin_id)`).run(telegramId, key);
        db.prepare("UPDATE checkins SET account_key = ? WHERE telegram_id = ? AND account_key = ''")
          .run(key, telegramId);
        db.prepare(`INSERT INTO untappd_had(telegram_id, account_key, beer_id, last_seen_at, user_rating)
          SELECT telegram_id, ?, beer_id, last_seen_at, user_rating FROM untappd_had
          WHERE telegram_id = ? AND account_key = ''
          ON CONFLICT(telegram_id, account_key, beer_id) DO UPDATE SET
            user_rating = CASE WHEN excluded.last_seen_at > untappd_had.last_seen_at
              THEN COALESCE(excluded.user_rating, untappd_had.user_rating)
              ELSE COALESCE(untappd_had.user_rating, excluded.user_rating) END,
            last_seen_at = MAX(untappd_had.last_seen_at, excluded.last_seen_at)`).run(key, telegramId);
        db.prepare("DELETE FROM untappd_had WHERE telegram_id = ? AND account_key = ''").run(telegramId);
        // Imports do not establish feed coverage or totals; do not adopt those.
      }
      db.prepare(`UPDATE user_profiles SET untappd_link_revision = untappd_link_revision + 1,
        legacy_sync_revision = CASE WHEN ? THEN untappd_link_revision + 1 ELSE legacy_sync_revision END
        WHERE telegram_id = ?`).run(firstLink ? 1 : 0, telegramId);
    }
    db.prepare('UPDATE user_profiles SET untappd_username = ? WHERE telegram_id = ?')
      .run(username, telegramId);
  }).immediate();
}

export function getProfile(db: DB, telegramId: number): ProfileRow | null {
  return (db.prepare('SELECT * FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as ProfileRow | undefined) ?? null;
}

export function getUserCity(db: DB, telegramId: number): string {
  const row = db
    .prepare('SELECT city FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { city: string | null } | undefined;
  const v = row?.city;
  // NULL (never chose a city) and any stale/unknown slug both mean "outside Poland":
  // showing a stranger's Warszawa would be worse than showing nothing (#399).
  return v != null && isSelectableCity(v) ? v : OUTSIDE_CITY;
}

export function setUserCity(db: DB, telegramId: number, slug: string): void {
  db.prepare('UPDATE user_profiles SET city = ? WHERE telegram_id = ?').run(slug, telegramId);
}

export function allProfiles(db: DB): ProfileRow[] {
  return db.prepare('SELECT * FROM user_profiles').all() as ProfileRow[];
}

const KNOWN_LOCALES = new Set<string>(['uk', 'pl', 'en']);

/** A stored language string narrowed to a Locale; null for unset or unrecognized. */
export function toLocale(v: string | null | undefined): Locale | null {
  return v != null && KNOWN_LOCALES.has(v) ? (v as Locale) : null;
}

export function getUserLanguage(db: DB, telegramId: number): Locale | null {
  const row = db
    .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { language: string | null } | undefined;
  return toLocale(row?.language);
}

export function setUserLanguage(db: DB, telegramId: number, lang: Locale): void {
  db.prepare('UPDATE user_profiles SET language = ? WHERE telegram_id = ?').run(lang, telegramId);
}
