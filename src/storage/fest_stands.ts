import type { DB } from './db';

export interface FestStand {
  section: string;
  floor: string | null;
  stand: string | null;
}

// Stands are entered by people (CSV in the bot), keyed by the menu section they label.
export function upsertStand(db: DB, festId: number, s: FestStand, by: number, at: string): void {
  db.prepare(
    `INSERT INTO fest_stands (fest_id, section, floor, stand, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(fest_id, section) DO UPDATE SET floor = excluded.floor, stand = excluded.stand,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(festId, s.section, s.floor, s.stand, by, at);
}

export function standsFor(db: DB, festId: number): Map<string, FestStand> {
  const rows = db.prepare('SELECT section, floor, stand FROM fest_stands WHERE fest_id = ?').all(festId) as FestStand[];
  return new Map(rows.map((r) => [r.section, r]));
}
