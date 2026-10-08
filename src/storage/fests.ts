import type { DB } from './db';

export interface Fest {
  id: number;
  slug: string;
  name: string;
  menu_venue_id: number;
  target_min_rating: number;
  target_style_patterns: string[];
}

export interface FestSession {
  session_no: number;
  start_at: string;
  end_at: string;
}

export interface FestVenue {
  venue_id: number;
  label: string;
  feed_path: string;
}

// Polling starts 30 min before a session and ends 30 min after it: people check in late, and
// the first tick needs history from before the doors open (spec §6.1).
export const POLL_MARGIN_MS = 30 * 60 * 1000;

interface FestRow extends Omit<Fest, 'target_style_patterns'> {
  target_style_patterns: string;
}

function toFest(row: FestRow): Fest {
  return { ...row, target_style_patterns: JSON.parse(row.target_style_patterns) as string[] };
}

export function getFestBySlug(db: DB, slug: string): Fest | null {
  const row = db.prepare('SELECT * FROM fests WHERE slug = ?').get(slug) as FestRow | undefined;
  return row ? toFest(row) : null;
}

export function getFest(db: DB, festId: number): Fest | null {
  const row = db.prepare('SELECT * FROM fests WHERE id = ?').get(festId) as FestRow | undefined;
  return row ? toFest(row) : null;
}

export function festSessions(db: DB, festId: number): FestSession[] {
  return db
    .prepare('SELECT session_no, start_at, end_at FROM fest_sessions WHERE fest_id = ? ORDER BY session_no')
    .all(festId) as FestSession[];
}

export function festVenues(db: DB, festId: number): FestVenue[] {
  return db
    .prepare('SELECT venue_id, label, feed_path FROM fest_venues WHERE fest_id = ? ORDER BY venue_id')
    .all(festId) as FestVenue[];
}

/** The session whose polling window (session ± POLL_MARGIN_MS, inclusive) contains `now`. */
export function pollingSessionAt(db: DB, festId: number, now: Date): FestSession | null {
  const t = now.getTime();
  return festSessions(db, festId).find((s) =>
    t >= Date.parse(s.start_at) - POLL_MARGIN_MS && t <= Date.parse(s.end_at) + POLL_MARGIN_MS,
  ) ?? null;
}

/**
 * Fests whose last polling window has not closed yet — being polled now or still ahead — earliest
 * first. The menu is read during the run-up, before any window opens.
 */
export function currentOrNextFests(db: DB, now: Date): Fest[] {
  const rows = db
    .prepare(
      `SELECT f.* FROM fests f JOIN fest_sessions s ON s.fest_id = f.id
        GROUP BY f.id
       HAVING MAX(s.end_at) >= ?
        ORDER BY MIN(s.start_at), f.id`,
    )
    .all(new Date(now.getTime() - POLL_MARGIN_MS).toISOString()) as FestRow[];
  return rows.map(toFest);
}

/** The earliest of `currentOrNextFests`, if any. */
export function currentOrNextFest(db: DB, now: Date): Fest | null {
  return currentOrNextFests(db, now)[0] ?? null;
}

/** Every fest being polled at `now`, with its session. Windows of different fests may overlap. */
export function activeFests(db: DB, now: Date): { fest: Fest; session: FestSession }[] {
  const rows = db.prepare('SELECT * FROM fests ORDER BY id').all() as FestRow[];
  return rows.flatMap((row) => {
    const session = pollingSessionAt(db, row.id, now);
    return session ? [{ fest: toFest(row), session }] : [];
  });
}

/** The first fest being polled at `now`, if any — for callers with nothing to choose by. */
export function activeFest(db: DB, now: Date): { fest: Fest; session: FestSession } | null {
  return activeFests(db, now)[0] ?? null;
}

export function updateFestVenueFeedPath(db: DB, venueId: number, feedPath: string): number {
  const info = db.prepare('UPDATE fest_venues SET feed_path = ? WHERE venue_id = ?').run(feedPath, venueId);
  return info.changes as number;
}

