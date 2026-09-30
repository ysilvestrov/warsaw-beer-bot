import type { DB } from './db';

export interface FestMenuRow {
  beer_id: number;
  section: string;
  untappd_id: number | null;
  name: string;
  brewery: string;
  style: string | null;
  abv: number | null;
  rating_global: number | null;
  first_seen_at: string;
  last_seen_at: string;
}

// One row per (beer, section): the same beer can be poured at two exhibitors (a collab), and each
// stand is a place to find it. A menu item that disappears is kept: the menu only grows during the
// run-up, and a vanished row is more likely a render hiccup than a withdrawn beer. last_seen_at
// tells them apart.
export function upsertMenuItem(db: DB, festId: number, beerId: number, section: string, seenAt: string): void {
  db.prepare(
    `INSERT INTO fest_menu (fest_id, beer_id, section, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fest_id, beer_id, section) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(festId, beerId, section, seenAt, seenAt);
}

export function menuFor(db: DB, festId: number): FestMenuRow[] {
  return db
    .prepare(
      `SELECT m.beer_id, m.section, b.untappd_id, b.name, b.brewery, b.style, b.abv, b.rating_global,
              m.first_seen_at, m.last_seen_at
         FROM fest_menu m JOIN beers b ON b.id = m.beer_id
        WHERE m.fest_id = ?
        ORDER BY m.section, b.name`,
    )
    .all(festId) as FestMenuRow[];
}

export function menuStats(db: DB, festId: number): { count: number; lastSeenAt: string | null } {
  return db
    .prepare('SELECT COUNT(DISTINCT beer_id) AS count, MAX(last_seen_at) AS lastSeenAt FROM fest_menu WHERE fest_id = ?')
    .get(festId) as { count: number; lastSeenAt: string | null };
}
