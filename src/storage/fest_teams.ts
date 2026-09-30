import type { DB } from './db';

export interface FestTeam {
  id: number;
  fest_id: number;
  chat_id: number;
}

export interface FestMember {
  telegram_id: number;
  initials: string;
  untappd_username: string | null;
}

export type OverrideAction = 'add' | 'remove';

export function teamByChat(db: DB, festId: number, chatId: number): FestTeam | null {
  return (db.prepare('SELECT id, fest_id, chat_id FROM fest_teams WHERE fest_id = ? AND chat_id = ?')
    .get(festId, chatId) as FestTeam | undefined) ?? null;
}

export function createTeam(db: DB, festId: number, chatId: number, now: string): FestTeam {
  db.prepare('INSERT OR IGNORE INTO fest_teams (fest_id, chat_id, created_at) VALUES (?, ?, ?)').run(festId, chatId, now);
  return teamByChat(db, festId, chatId)!;
}

export function addMember(db: DB, teamId: number, telegramId: number, initials: string, now: string): void {
  db.prepare(
    `INSERT INTO fest_team_members (team_id, telegram_id, initials, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, telegram_id) DO NOTHING`,
  ).run(teamId, telegramId, initials, now);
}

export function members(db: DB, teamId: number): FestMember[] {
  return db
    .prepare(
      `SELECT m.telegram_id, m.initials, p.untappd_username
         FROM fest_team_members m JOIN user_profiles p ON p.telegram_id = m.telegram_id
        WHERE m.team_id = ?
        ORDER BY m.joined_at, m.telegram_id`,
    )
    .all(teamId) as FestMember[];
}

/** Whether `telegramId` belongs to any team of `festId` — the gate for the ingest endpoints. */
export function isFestMember(db: DB, festId: number, telegramId: number): boolean {
  return db
    .prepare(
      `SELECT 1 FROM fest_team_members m JOIN fest_teams t ON t.id = m.team_id
        WHERE t.fest_id = ? AND m.telegram_id = ? LIMIT 1`,
    )
    .get(festId, telegramId) !== undefined;
}

export function setOverride(db: DB, teamId: number, beerId: number, action: OverrideAction, by: number, now: string): void {
  db.prepare(
    `INSERT INTO fest_target_overrides (team_id, beer_id, action, by_telegram_id, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, beer_id) DO UPDATE SET action = excluded.action,
       by_telegram_id = excluded.by_telegram_id, at = excluded.at`,
  ).run(teamId, beerId, action, by, now);
}

export function overridesFor(db: DB, teamId: number): Map<number, OverrideAction> {
  const rows = db.prepare('SELECT beer_id, action FROM fest_target_overrides WHERE team_id = ?')
    .all(teamId) as { beer_id: number; action: OverrideAction }[];
  return new Map(rows.map((r) => [r.beer_id, r.action]));
}

export function teamById(db: DB, teamId: number): FestTeam | null {
  return (db.prepare('SELECT id, fest_id, chat_id FROM fest_teams WHERE id = ?').get(teamId) as FestTeam | undefined) ?? null;
}

/** Teams of `festId` that `telegramId` belongs to, oldest first. */
export function teamsOfUser(db: DB, festId: number, telegramId: number): FestTeam[] {
  return db
    .prepare(
      `SELECT t.id, t.fest_id, t.chat_id FROM fest_teams t JOIN fest_team_members m ON m.team_id = t.id
        WHERE t.fest_id = ? AND m.telegram_id = ? ORDER BY t.id`,
    )
    .all(festId, telegramId) as FestTeam[];
}

export function isTeamMember(db: DB, teamId: number, telegramId: number): boolean {
  return db.prepare('SELECT 1 FROM fest_team_members WHERE team_id = ? AND telegram_id = ?').get(teamId, telegramId) !== undefined;
}

export function teamsOfFest(db: DB, festId: number): FestTeam[] {
  return db.prepare('SELECT id, fest_id, chat_id FROM fest_teams WHERE fest_id = ? ORDER BY id').all(festId) as FestTeam[];
}

/** Every member of any team of the fest with a linked Untappd, keyed by lower-case username. */
export function festMembersByUsername(db: DB, festId: number): Map<string, number> {
  const rows = db.prepare(
    `SELECT DISTINCT lower(p.untappd_username) AS username, m.telegram_id AS telegramId
       FROM fest_team_members m
       JOIN fest_teams t ON t.id = m.team_id
       JOIN user_profiles p ON p.telegram_id = m.telegram_id
      WHERE t.fest_id = ? AND p.untappd_username IS NOT NULL`,
  ).all(festId) as { username: string; telegramId: number }[];
  return new Map(rows.map((r) => [r.username, r.telegramId]));
}
