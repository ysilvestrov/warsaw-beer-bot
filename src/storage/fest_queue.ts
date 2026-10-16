import type { DB } from './db';
import { canonicalCheckinAt } from '../domain/checkin-time';

export interface QueueRow {
  id: number;
  glass_no: number;
  beer_id: number;
  added_by: number;
  added_at: string;
}

/** A member's check-in of a beer, from their own history or from an authored venue row (spec §6.4). */
export interface MemberCheckin {
  telegramId: number;
  beerId: number;
  checkinId: string;
  /** ISO-8601 UTC with 'Z', whichever table it came from. */
  checkinAt: string;
}

/** A second tap on the same «Взяв» within this window is the same glass, not a new one. */
export const REPEAT_TAP_MS = 30 * 1000;

// "Взяв" (spec §7): the next glass number and a queued print job in one transaction, so two
// members pressing at once get two numbers and every number has its print job. Glass numbers are
// per team and never reused, a cancelled one included; they also name the pre-printed stickers (spec §8, level 3). The same
// member taking the same beer again within REPEAT_TAP_MS gets that glass back: on a phone in a
// crowd a double tap is far likelier than two identical glasses half a minute apart.
export function takeBeer(db: DB, p: { teamId: number; beerId: number; addedBy: number; at: string }): { id: number; glassNo: number; repeated: boolean } {
  // Stored and compared as canonical ISO 'Z' text, so the window is a comparison of instants.
  const at = new Date(p.at).toISOString();
  return db.transaction(() => {
    const since = new Date(Date.parse(at) - REPEAT_TAP_MS).toISOString();
    const recent = db.prepare(
      `SELECT id, glass_no FROM fest_queue
        WHERE team_id = ? AND beer_id = ? AND added_by = ? AND added_at >= ? AND added_at <= ?
        ORDER BY glass_no DESC LIMIT 1`,
    ).get(p.teamId, p.beerId, p.addedBy, since, at) as { id: number; glass_no: number } | undefined;
    if (recent) return { id: recent.id, glassNo: recent.glass_no, repeated: true };
    // A cancelled glass keeps its number (fest_glass_removed): the next one never reuses it.
    const { next } = db.prepare(
      `SELECT MAX(COALESCE((SELECT MAX(glass_no) FROM fest_queue WHERE team_id = ?), 0),
                  COALESCE((SELECT MAX(glass_no) FROM fest_glass_removed WHERE team_id = ?), 0)) + 1 AS next`,
    ).get(p.teamId, p.teamId) as { next: number };
    // The row id is the print job's key, so it is never reused either: SQLite would give a deleted top
    // id again (no AUTOINCREMENT), and a station's late report on the cancelled job would land here.
    const id = Number(db.prepare(
      `INSERT INTO fest_queue (id, team_id, glass_no, beer_id, added_by, added_at)
       VALUES (MAX(COALESCE((SELECT MAX(id) FROM fest_queue), 0),
                   COALESCE((SELECT MAX(queue_id) FROM fest_glass_removed), 0)) + 1, ?, ?, ?, ?, ?)`,
    ).run(p.teamId, next, p.beerId, p.addedBy, at).lastInsertRowid);
    db.prepare("INSERT INTO fest_print_jobs (queue_id, status, attempts, updated_at) VALUES (?, 'queued', 0, ?)").run(id, at);
    return { id, glassNo: next, repeated: false };
  }).immediate();
}

export function queueFor(db: DB, teamId: number): QueueRow[] {
  return db.prepare('SELECT id, glass_no, beer_id, added_by, added_at FROM fest_queue WHERE team_id = ? ORDER BY glass_no')
    .all(teamId) as QueueRow[];
}

export type RemoveGlassResult =
  | { kind: 'removed'; name: string; printed: boolean }
  | { kind: 'already' }
  | { kind: 'missing' };

// A glass taken by mistake (spec: cancelling a glass): the queue row and its print job go, its number
// and row id are tombstoned so takeBeer never gives either again. `printed` is the label's state at this moment — a
// station may still be printing it. Whether a check-in already closed the glass is the caller's check.
export function removeGlass(db: DB, p: { teamId: number; glassNo: number; at: string }): RemoveGlassResult {
  const at = new Date(p.at).toISOString();
  return db.transaction((): RemoveGlassResult => {
    const row = db.prepare(
      `SELECT q.id, b.name, j.status FROM fest_queue q
         JOIN beers b ON b.id = q.beer_id
         LEFT JOIN fest_print_jobs j ON j.queue_id = q.id
        WHERE q.team_id = ? AND q.glass_no = ?`,
    ).get(p.teamId, p.glassNo) as { id: number; name: string; status: string | null } | undefined;
    if (!row) {
      const gone = db.prepare('SELECT 1 FROM fest_glass_removed WHERE team_id = ? AND glass_no = ?').get(p.teamId, p.glassNo);
      return gone ? { kind: 'already' } : { kind: 'missing' };
    }
    // Its print job goes with it: fest_print_jobs.queue_id is ON DELETE CASCADE, and openDb turns foreign keys on.
    db.prepare('DELETE FROM fest_queue WHERE id = ?').run(row.id);
    db.prepare('INSERT INTO fest_glass_removed (team_id, glass_no, queue_id, removed_at) VALUES (?, ?, ?, ?)')
      .run(p.teamId, p.glassNo, row.id, at);
    return { kind: 'removed', name: row.name, printed: row.status === 'printed' };
  }).immediate();
}

// Two sources, one shape. checkins.checkin_at is canonical 'YYYY-MM-DD HH:MM:SS' UTC without a zone
// (Date.parse would read it as local time), venue_checkins.checkin_at is ISO with 'Z'; both leave
// here as ISO 'Z'. Venue rows carry the author as shown on the site, history keys are lower-case,
// so names are compared without case, and a venue row without an author closes nothing.
export function memberBeerCheckins(
  db: DB,
  p: { members: { telegramId: number; untappdUsername: string | null }[]; beerIds: number[]; sinceIso: string },
): MemberCheckin[] {
  if (p.beerIds.length === 0) return [];
  const beerMarks = p.beerIds.map(() => '?').join(',');
  const own = db.prepare(
    `SELECT c.checkin_id AS checkinId, c.beer_id AS beerId, c.checkin_at AS at
       FROM checkins c JOIN user_profiles u ON u.telegram_id = c.telegram_id
      WHERE c.telegram_id = ? AND c.account_key = lower(COALESCE(u.untappd_username, ''))
        AND c.beer_id IN (${beerMarks}) AND c.checkin_at >= ?`,
  );
  const atVenue = db.prepare(
    `SELECT v.checkin_id AS checkinId, b.id AS beerId, v.checkin_at AS at
       FROM venue_checkins v JOIN beers b ON b.untappd_id = v.bid
      WHERE lower(v.untappd_user) = lower(?) AND b.id IN (${beerMarks}) AND v.checkin_at >= ?`,
  );
  const sinceCanonical = canonicalCheckinAt(p.sinceIso);
  const out: MemberCheckin[] = [];
  for (const m of p.members) {
    for (const r of own.all(m.telegramId, ...p.beerIds, sinceCanonical) as { checkinId: string; beerId: number; at: string }[]) {
      out.push({ telegramId: m.telegramId, beerId: r.beerId, checkinId: r.checkinId, checkinAt: `${r.at.replace(' ', 'T')}.000Z` });
    }
    if (m.untappdUsername === null) continue;
    for (const r of atVenue.all(m.untappdUsername, ...p.beerIds, p.sinceIso) as { checkinId: number; beerId: number; at: string }[]) {
      out.push({ telegramId: m.telegramId, beerId: r.beerId, checkinId: String(r.checkinId), checkinAt: r.at });
    }
  }
  return out;
}

// Manual marks (spec 2026-10-15-fest-queue-reality-design.md §PR 2): a member's own word that a glass is
// done for them — drunk without a check-in that closes it, or not drunk at all. Shown as ☑️, never as ✅.

/** true when the mark is new; a second mark of the same glass by the same member changes nothing. */
export function markGlass(db: DB, p: { queueId: number; telegramId: number; at: string }): boolean {
  return db.prepare('INSERT OR IGNORE INTO fest_glass_marks (queue_id, telegram_id, marked_at) VALUES (?, ?, ?)')
    .run(p.queueId, p.telegramId, new Date(p.at).toISOString()).changes === 1;
}

/** true when there was a mark to take back. */
export function unmarkGlass(db: DB, p: { queueId: number; telegramId: number }): boolean {
  return db.prepare('DELETE FROM fest_glass_marks WHERE queue_id = ? AND telegram_id = ?').run(p.queueId, p.telegramId).changes === 1;
}

export function glassMarks(db: DB, teamId: number): { queueId: number; telegramId: number }[] {
  return db.prepare(
    `SELECT k.queue_id AS queueId, k.telegram_id AS telegramId
       FROM fest_glass_marks k JOIN fest_queue q ON q.id = k.queue_id
      WHERE q.team_id = ? ORDER BY k.queue_id, k.telegram_id`,
  ).all(teamId) as { queueId: number; telegramId: number }[];
}
