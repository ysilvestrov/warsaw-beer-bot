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
 * The earliest fest whose last polling window has not closed yet — the one being polled now or
 * the next one. The menu is read during the run-up, before any window opens.
 */
export function currentOrNextFest(db: DB, now: Date): Fest | null {
  const row = db
    .prepare(
      `SELECT f.* FROM fests f JOIN fest_sessions s ON s.fest_id = f.id
        GROUP BY f.id
       HAVING MAX(s.end_at) >= ?
        ORDER BY MIN(s.start_at), f.id
        LIMIT 1`,
    )
    .get(new Date(now.getTime() - POLL_MARGIN_MS).toISOString()) as FestRow | undefined;
  return row ? toFest(row) : null;
}

/** The fest (and its session) that is being polled at `now`, if any. */
export function activeFest(db: DB, now: Date): { fest: Fest; session: FestSession } | null {
  const rows = db.prepare('SELECT * FROM fests ORDER BY id').all() as FestRow[];
  for (const row of rows) {
    const session = pollingSessionAt(db, row.id, now);
    if (session) return { fest: toFest(row), session };
  }
  return null;
}
