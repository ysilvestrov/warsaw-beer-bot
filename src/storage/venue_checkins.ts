import type { DB } from './db';

export type Eye = 'laptop' | 'server' | 'friend_feed';

export interface VenueCheckinInput {
  checkin_id: number;
  venue_id: number;
  bid: number;
  untappd_user: string | null;
  checkin_at: string;
}

export interface VenueCheckin {
  checkin_id: number;
  venue_id: number;
  bid: number;
  checkin_at: string;
}

// checkin_id is Untappd's own id, so the same check-in seen by two eyes is one row; the first
// eye to see it keeps the credit.
export function insertVenueCheckins(db: DB, rows: VenueCheckinInput[], eye: Eye, observedAt: string): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO venue_checkins (checkin_id, venue_id, bid, untappd_user, checkin_at, first_eye, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const r of rows) {
    inserted += stmt.run(r.checkin_id, r.venue_id, r.bid, r.untappd_user, r.checkin_at, eye, observedAt).changes;
  }
  return inserted;
}

export function venueCheckinAt(db: DB, checkinId: number): string | null {
  const row = db.prepare('SELECT checkin_at FROM venue_checkins WHERE checkin_id = ?').get(checkinId) as
    | { checkin_at: string }
    | undefined;
  return row ? row.checkin_at : null;
}

/** Check-ins at any of `venueIds` strictly after `sinceIso`. */
export function checkinsSince(db: DB, venueIds: number[], sinceIso: string): VenueCheckin[] {
  if (venueIds.length === 0) return [];
  const marks = venueIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT checkin_id, venue_id, bid, checkin_at FROM venue_checkins
        WHERE venue_id IN (${marks}) AND checkin_at > ?
        ORDER BY checkin_at DESC`,
    )
    .all(...venueIds, sinceIso) as VenueCheckin[];
}
