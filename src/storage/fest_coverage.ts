import type { DB } from './db';
import type { Eye } from './venue_checkins';

export interface CoverageInterval {
  from_at: string;
  to_at: string;
}

// Raw proven spans, one per ingested page; the union is taken at read time (domain/fest/coverage).
// A few hundred rows per festival day, so there is nothing to merge for.
export function addCoverage(db: DB, venueId: number, span: CoverageInterval, eye: Eye, recordedAt: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO fest_coverage (venue_id, from_at, to_at, eye, recorded_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(venueId, span.from_at, span.to_at, eye, recordedAt);
}

/** Every span that ends at or after `sinceIso` — the ones that can cover a window starting there. */
export function coverageSince(db: DB, venueId: number, sinceIso: string): CoverageInterval[] {
  return db
    .prepare('SELECT from_at, to_at FROM fest_coverage WHERE venue_id = ? AND to_at >= ? ORDER BY from_at')
    .all(venueId, sinceIso) as CoverageInterval[];
}
