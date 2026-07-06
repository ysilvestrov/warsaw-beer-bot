import type { DB } from './db';

export interface EnrichFailureRow {
  beer_id: number;
  brewery: string;
  name: string;
  search_url: string;
  source_url: string;
  outcome: 'not_found' | 'blocked';
  candidates_count: number;
  candidates_summary: string;
  at: string; // ISO timestamp of this failure
}

// One row per failing beer. Upsert on beer_id: a repeat failure refreshes the
// diagnostic fields and bumps fail_count. The row is cleared (clearEnrichFailure)
// when the beer eventually matches, and CASCADE-deleted if the beer row is removed.
export function recordEnrichFailure(db: DB, r: EnrichFailureRow): void {
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id, brewery, name, search_url, source_url, outcome, candidates_count, candidates_summary, fail_count, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(beer_id) DO UPDATE SET
       brewery            = excluded.brewery,
       name               = excluded.name,
       search_url         = excluded.search_url,
       source_url         = CASE WHEN excluded.source_url != '' THEN excluded.source_url
                                 ELSE enrich_failures.source_url END,
       outcome            = excluded.outcome,
       candidates_count   = excluded.candidates_count,
       candidates_summary = excluded.candidates_summary,
       fail_count         = enrich_failures.fail_count + 1,
       last_at            = excluded.last_at,
       review_class       = NULL,
       review_note        = NULL,
       reviewed_at        = NULL`,
  ).run(
    r.beer_id, r.brewery, r.name, r.search_url, r.source_url, r.outcome,
    r.candidates_count, r.candidates_summary, r.at,
  );
}

export function clearEnrichFailure(db: DB, beerId: number): void {
  db.prepare('DELETE FROM enrich_failures WHERE beer_id = ?').run(beerId);
}

// True when the beer was triaged as `wontfix` (intentionally never matched).
// Such orphans are excluded from enrich pools so we stop re-querying Untappd.
export function isWontfix(db: DB, beerId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM enrich_failures WHERE beer_id = ? AND review_class = 'wontfix'`,
      )
      .get(beerId) !== undefined
  );
}

// Values must stay in sync with the CHECK on enrich_failures.review_class (schema migration 12).
export type ReviewClass = 'parser_bug' | 'matcher_bug' | 'not_on_untappd' | 'wontfix';

// Marks an orphan failure as triaged. Returns false if no row exists for beerId
// (e.g. the failure already cleared because the beer matched). A later recurring
// failure resets these fields via recordEnrichFailure's ON CONFLICT clause.
export function setEnrichFailureReview(
  db: DB,
  beerId: number,
  reviewClass: ReviewClass,
  note: string | null,
  atIso: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE enrich_failures
         SET review_class = ?, review_note = ?, reviewed_at = ?
       WHERE beer_id = ?`,
    )
    .run(reviewClass, note, atIso, beerId);
  return info.changes > 0;
}

export interface UntriagedFailure {
  beer_id: number;
  brewery: string;
  name: string;
  search_url: string;
  source_url: string;
  candidates_count: number;
  candidates_summary: string;
  fail_count: number;
  last_at: string;
}

// Newest untriaged not_found failures for the daily triage job. `blocked` rows
// are proxy/ban trouble, not matching trouble, and are excluded. Newest-first so
// fresh signal is triaged before the stale backlog.
export function listUntriagedFailures(db: DB, limit: number): UntriagedFailure[] {
  return db
    .prepare(
      `SELECT beer_id, brewery, name, search_url, source_url,
              candidates_count, candidates_summary, fail_count, last_at
         FROM enrich_failures
        WHERE review_class IS NULL AND outcome = 'not_found'
        ORDER BY last_at DESC, beer_id DESC
        LIMIT ?`,
    )
    .all(limit) as UntriagedFailure[];
}
