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
// per team and never reused; they also name the pre-printed stickers (spec §8, level 3). The same
// member taking the same beer again within REPEAT_TAP_MS gets that glass back: on a phone in a
// crowd a double tap is far likelier than two identical glasses half a minute apart.
export function takeBeer(db: DB, p: { teamId: number; beerId: number; addedBy: number; at: string }): { id: number; glassNo: number; repeated: boolean } {
  return db.transaction(() => {
    const since = new Date(Date.parse(p.at) - REPEAT_TAP_MS).toISOString();
    const recent = db.prepare(
      `SELECT id, glass_no FROM fest_queue
        WHERE team_id = ? AND beer_id = ? AND added_by = ? AND added_at >= ? AND added_at <= ?
        ORDER BY glass_no DESC LIMIT 1`,
    ).get(p.teamId, p.beerId, p.addedBy, since, p.at) as { id: number; glass_no: number } | undefined;
    if (recent) return { id: recent.id, glassNo: recent.glass_no, repeated: true };
    const { next } = db.prepare('SELECT COALESCE(MAX(glass_no), 0) + 1 AS next FROM fest_queue WHERE team_id = ?')
      .get(p.teamId) as { next: number };
    const id = Number(db.prepare(
      'INSERT INTO fest_queue (team_id, glass_no, beer_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)',
    ).run(p.teamId, next, p.beerId, p.addedBy, p.at).lastInsertRowid);
    db.prepare("INSERT INTO fest_print_jobs (queue_id, status, attempts, updated_at) VALUES (?, 'queued', 0, ?)").run(id, p.at);
    return { id, glassNo: next, repeated: false };
  }).immediate();
}

export function queueFor(db: DB, teamId: number): QueueRow[] {
  return db.prepare('SELECT id, glass_no, beer_id, added_by, added_at FROM fest_queue WHERE team_id = ? ORDER BY glass_no')
    .all(teamId) as QueueRow[];
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
