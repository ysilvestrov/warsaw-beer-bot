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

// checkin_id is Untappd's own id, so the same check-in seen by two eyes is one row; the first eye
// keeps the credit. Venue, bid and time are Untappd's facts for that id and cannot differ between
// honest eyes; the author can be missing in one source and present in another, so a later eye
// fills it in.
export function insertVenueCheckins(db: DB, rows: VenueCheckinInput[], eye: Eye, observedAt: string): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO venue_checkins (checkin_id, venue_id, bid, untappd_user, checkin_at, first_eye, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const fillAuthor = db.prepare(
    'UPDATE venue_checkins SET untappd_user = ? WHERE checkin_id = ? AND untappd_user IS NULL',
  );
  let inserted = 0;
  for (const r of rows) {
    const n = insert.run(r.checkin_id, r.venue_id, r.bid, r.untappd_user, r.checkin_at, eye, observedAt).changes;
    inserted += n;
    if (n === 0 && r.untappd_user !== null) fillAuthor.run(r.untappd_user, r.checkin_id);
  }
  return inserted;
}

/** Time of a stored check-in at this venue; null if unknown here — a cursor from another venue proves nothing. */
export function venueCheckinAt(db: DB, checkinId: number, venueId: number): string | null {
  const row = db.prepare('SELECT checkin_at FROM venue_checkins WHERE checkin_id = ? AND venue_id = ?').get(checkinId, venueId) as
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
