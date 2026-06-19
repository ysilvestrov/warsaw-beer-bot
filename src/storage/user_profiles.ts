import type { DB } from './db';
import type { Locale } from '../i18n/types';
import { DEFAULT_CITY, isKnownCity } from '../domain/cities';

export interface ProfileRow {
  telegram_id: number;
  untappd_username: string | null;
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
  db.prepare('UPDATE user_profiles SET untappd_username = ? WHERE telegram_id = ?')
    .run(username, telegramId);
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
  return v != null && isKnownCity(v) ? v : DEFAULT_CITY;
}

export function setUserCity(db: DB, telegramId: number, slug: string): void {
  db.prepare('UPDATE user_profiles SET city = ? WHERE telegram_id = ?').run(slug, telegramId);
}

export function allProfiles(db: DB): ProfileRow[] {
  return db.prepare('SELECT * FROM user_profiles').all() as ProfileRow[];
}

const KNOWN_LOCALES = new Set<Locale>(['uk', 'pl', 'en']);

export function getUserLanguage(db: DB, telegramId: number): Locale | null {
  const row = db
    .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { language: string | null } | undefined;
  const v = row?.language;
  if (v == null) return null;
  return (KNOWN_LOCALES as Set<string>).has(v) ? (v as Locale) : null;
}

export function setUserLanguage(db: DB, telegramId: number, lang: Locale): void {
  db.prepare('UPDATE user_profiles SET language = ? WHERE telegram_id = ?').run(lang, telegramId);
}
