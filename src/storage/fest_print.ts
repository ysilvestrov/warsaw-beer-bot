import { randomBytes } from 'node:crypto';
import type { DB } from './db';
import { hashToken } from './api_tokens';

// Print station (spec §8): the station of a team fetches that team's print jobs and reports each
// label. Its token is a capability — 32 random bytes shown once in the link, kept here only as a
// SHA-256 — separate from the extension token, which is one per person and would be revoked by a
// new one.

export type PrintStatus = 'queued' | 'printed' | 'failed';

export interface PrintJob {
  id: number;
  glassNo: number;
  beerName: string;
  initials: string;
  status: PrintStatus;
  attempts: number;
  error: string | null;
}

const MAX_ERROR = 200;

export function createStation(db: DB, p: { teamId: number; createdBy: number; now: string; expiresAt: string }): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO fest_print_stations (token_hash, team_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), p.teamId, p.createdBy, p.now, p.expiresAt);
  return token;
}

/** The team a live station token belongs to; null for an unknown or expired token. */
export function stationTeam(db: DB, token: string, now: string): number | null {
  const row = db.prepare('SELECT team_id FROM fest_print_stations WHERE token_hash = ? AND expires_at > ?')
    .get(hashToken(token), now) as { team_id: number } | undefined;
  return row?.team_id ?? null;
}

/** Labels still to print for the team: queued ones and failed ones (to retry), by glass number. */
export function pendingJobs(db: DB, teamId: number): PrintJob[] {
  return db.prepare(
    `SELECT q.id, q.glass_no AS glassNo, b.name AS beerName, COALESCE(m.initials, '?') AS initials,
            j.status, j.attempts, j.error
       FROM fest_print_jobs j
       JOIN fest_queue q ON q.id = j.queue_id
       JOIN beers b ON b.id = q.beer_id
       LEFT JOIN fest_team_members m ON m.team_id = q.team_id AND m.telegram_id = q.added_by
      WHERE q.team_id = ? AND j.status IN ('queued', 'failed')
      ORDER BY q.glass_no`,
  ).all(teamId) as PrintJob[];
}

function setStatus(db: DB, teamId: number, queueId: number, set: string, args: unknown[]): boolean {
  return db.prepare(
    `UPDATE fest_print_jobs SET ${set}
      WHERE queue_id = ? AND queue_id IN (SELECT id FROM fest_queue WHERE team_id = ?)`,
  ).run(...args, queueId, teamId).changes === 1;
}

/** A label the printer finished. Only a job of the station's own team; false otherwise. */
export function markPrinted(db: DB, teamId: number, queueId: number, now: string): boolean {
  return setStatus(db, teamId, queueId, "status = 'printed', attempts = attempts + 1, error = NULL, updated_at = ?", [now]);
}

export function markFailed(db: DB, teamId: number, queueId: number, error: string, now: string): boolean {
  return setStatus(db, teamId, queueId, "status = 'failed', attempts = attempts + 1, error = ?, updated_at = ?", [error.slice(0, MAX_ERROR), now]);
}

/** "Print again": back to the queue, whatever it was. */
export function requeue(db: DB, teamId: number, queueId: number, now: string): boolean {
  return setStatus(db, teamId, queueId, "status = 'queued', error = NULL, updated_at = ?", [now]);
}
