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
// diagnostic fields and bumps fail_count. The prior triage classification
// (review_class/review_note/reviewed_at) is preserved on re-fail UNLESS
// candidates_count crosses the 0↔>0 boundary, in which case it is cleared to
// re-open the row for triage. The row is cleared (clearEnrichFailure)
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
       review_class       = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
         THEN NULL ELSE enrich_failures.review_class END,
       review_note        = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
         THEN NULL ELSE enrich_failures.review_note END,
       reviewed_at        = CASE
         WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
         THEN NULL ELSE enrich_failures.reviewed_at END`,
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

// True when the METERED web fallback (#139) must not spend a request on this beer.
// Superset of isWontfix: `parser_bug` means the query string itself is garbage, so
// searching the web with the same wrong string cannot help; `not_on_untappd` means
// triage already established the page does not exist; `retired_at` means a shipped
// fix already resolved the row. The free Algolia retry keeps running for all of
// these — only the paid path is tightened (#351).
export function isWebFallbackBlocked(db: DB, beerId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM enrich_failures
          WHERE beer_id = ?
            AND (review_class IN ('wontfix', 'parser_bug', 'not_on_untappd')
                 OR retired_at IS NOT NULL)`,
      )
      .get(beerId) !== undefined
  );
}

// Values must stay in sync with the CHECK on enrich_failures.review_class (schema migration 12).
export type ReviewClass = 'parser_bug' | 'matcher_bug' | 'not_on_untappd' | 'wontfix';

// Marks an orphan failure as triaged. Returns false if no row exists for beerId
// (e.g. the failure already cleared because the beer matched). A later recurring
// failure only resets these fields via recordEnrichFailure's ON CONFLICT clause
// when candidates_count crosses the 0↔>0 boundary; otherwise the classification
// is preserved.
export function setEnrichFailureReview(
  db: DB,
  beerId: number,
  reviewClass: ReviewClass,
  note: string | null,
  atIso: string,
  issueNumber: number | null = null,
): boolean {
  const info = db
    .prepare(
      `UPDATE enrich_failures
         SET review_class = ?, review_note = ?, reviewed_at = ?, issue_number = ?
       WHERE beer_id = ?`,
    )
    .run(reviewClass, note, atIso, issueNumber, beerId);
  return info.changes > 0;
}

// Rows attached to an issue AFTER a given instant — the saturation signal (#408).
// It counts post-creation rows on purpose: #405 was created carrying 15 enumerated
// rows, which is exactly the proposed threshold, so counting lifetime rows would
// reject the very shape (a narrow issue born from a split) that the guard exists to
// encourage.
export function countRowsForIssue(db: DB, issueNumber: number, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM enrich_failures
        WHERE issue_number = ? AND reviewed_at > ?`,
    )
    .get(issueNumber, sinceIso) as { n: number };
  return row.n;
}

// Terminal state for a classified failure whose underlying problem is resolved
// (the responsible fix has shipped). Sets retired_at and appends `note` to
// review_note, preserving the original review_class for audit. When there is no
// prior note the note stands alone (no leading ` | ` separator). Idempotent:
// only rows not already retired are touched (WHERE retired_at IS NULL), so
// re-runs neither re-append the note nor overwrite the timestamp. Returns false
// when no eligible row exists (missing, or already retired).
export function retireEnrichFailure(
  db: DB,
  beerId: number,
  note: string,
  atIso: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE enrich_failures
         SET retired_at  = ?,
             review_note = CASE
               WHEN review_note IS NULL OR review_note = '' THEN ?
               ELSE review_note || ' | ' || ?
             END
       WHERE beer_id = ? AND retired_at IS NULL`,
    )
    .run(atIso, note, note, beerId);
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
  // From the beer row, not the failure row: the triage prompt needs the shop's own
  // ABV/style to check a candidate against instead of guessing.
  abv: number | null;
  style: string | null;
}

// Newest untriaged not_found failures for the daily triage job. `blocked` rows
// are proxy/ban trouble, not matching trouble, and are excluded. Newest-first so
// fresh signal is triaged before the stale backlog.
export function listUntriagedFailures(db: DB, limit: number): UntriagedFailure[] {
  return db
    .prepare(
      `SELECT ef.beer_id, ef.brewery, ef.name, ef.search_url, ef.source_url,
              ef.candidates_count, ef.candidates_summary, ef.fail_count, ef.last_at,
              b.abv AS abv, b.style AS style
         FROM enrich_failures ef
         JOIN beers b ON b.id = ef.beer_id
        WHERE ef.review_class IS NULL AND ef.outcome = 'not_found'
        ORDER BY ef.last_at DESC, ef.beer_id DESC
        LIMIT ?`,
    )
    .all(limit) as UntriagedFailure[];
}
