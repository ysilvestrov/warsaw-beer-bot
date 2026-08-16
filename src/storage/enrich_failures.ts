import type { DB } from './db';
import { REVIEW_CLASSES } from '../domain/review-class';

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
// re-open the row for triage. A `blocked` outcome is a separate rule (see the
// guard below): it may CREATE a row but never overwrites an existing one. The
// row is cleared (clearEnrichFailure) when the beer eventually matches, and
// CASCADE-deleted if the beer row is removed.
//
// #421 beat 2: a row carrying `unlocked_at` is spending the free retry granted when its
// issue left the open set. Reaching this statement means that retry FAILED, which is the
// evidence that the verdict outlived the fix it named — so the verdict is retired and the
// row rejoins the triage pool with a fresh failure record. `unlocked_at` resets
// unconditionally: the only way a row gets here with it set is that its bet just settled.
// `issue_number` is deliberately kept — it is the residue that says WHICH fix was tested
// and did not cover this row, and the daily audit counts exactly that.
// Note the ordering with the blocked guard above: a blocked record returns before this
// statement, so an Untappd outage can never settle a bet it did not test.
export function recordEnrichFailure(db: DB, r: EnrichFailureRow): void {
  // #425: `outcome` records how the last attempt THAT LEARNED SOMETHING ended. A blocked
  // attempt learned nothing about the beer — it is a fact about us (throttled IP, open
  // circuit), so it may CREATE a row for a beer we have never recorded, but it must never
  // overwrite one that already carries a real observation.
  //
  // Two defects close here. (1) The crash: the upsert clears review_class only when
  // candidates_count crosses the 0<->>0 boundary, so on a row already at 0 the verdict
  // survived onto outcome='blocked' and violated migration 24's CHECK — throwing out of
  // enrichOrphans and ending the whole run. (2) The quiet one: listUntriagedFailures
  // excludes blocked rows, so a block window silently dropped untriaged rows out of the
  // triage queue over an outage that had nothing to do with them.
  //
  // The whole function body — the existence check, the branch decision, the narrow UPDATE,
  // and the fall-through upsert — runs inside one transaction, so a write decided on a
  // stale read cannot land. Note the mechanism under WAL: a reader does not block a writer,
  // so a second process CAN insert-and-triage a row in that window; what the transaction
  // buys is that our own later write then aborts (SQLITE_BUSY_SNAPSHOT) instead of silently
  // upserting outcome='blocked' over the verdict it just missed. This process is the
  // only writer today, so the wrapper buys nothing yet, but recordEnrichFailure is also
  // invoked from compiled ops runners against the prod DB (a second process on the same
  // file); wrapping the bare INSERT ... ON CONFLICT costs nothing (better-sqlite3 already
  // runs a single statement in an implicit transaction), so covering it costs nothing extra
  // while making the guarantee hold on every path, not just the one with an explicit read.
  db.transaction(() => {
    if (r.outcome === 'blocked') {
      // Existence is deliberately the whole test, not outcome: a blocked attempt bumps the
      // counter on ANY existing row (not_found or already-blocked) and must never reach the
      // general upsert below, so which outcome the row currently carries doesn't change
      // the decision.
      const existing = db.prepare('SELECT 1 FROM enrich_failures WHERE beer_id = ?').get(r.beer_id);
      if (existing) {
        db.prepare(
          `UPDATE enrich_failures
              SET fail_count = fail_count + 1, last_at = ?
            WHERE beer_id = ?`,
        ).run(r.at, r.beer_id);
        return; // returns from the transaction callback, skipping the upsert below —
                // recordEnrichFailure itself has nothing left to do after this call returns
      }
    }

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
             OR enrich_failures.unlocked_at IS NOT NULL
           THEN NULL ELSE enrich_failures.review_class END,
         review_note        = CASE
           WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
             OR enrich_failures.unlocked_at IS NOT NULL
           THEN NULL ELSE enrich_failures.review_note END,
         reviewed_at        = CASE
           WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
             OR enrich_failures.unlocked_at IS NOT NULL
           THEN NULL ELSE enrich_failures.reviewed_at END,
         unlocked_at        = NULL`,
    ).run(
      r.beer_id, r.brewery, r.name, r.search_url, r.source_url, r.outcome,
      r.candidates_count, r.candidates_summary, r.at,
    );
  })();
}

export function clearEnrichFailure(db: DB, beerId: number): void {
  db.prepare('DELETE FROM enrich_failures WHERE beer_id = ?').run(beerId);
}

// #421: rows held out of the pools by `lockedRowPredicate`, with the issue each is waiting
// on. The predicate itself lives in beers.ts because it is a pool concern; this is its
// read-side twin and the two must agree — a row listed here but not locked there would be
// re-armed for nothing. They cannot share text: the predicate is a fragment that hard-codes
// the `beers` alias `b`, exactly as orphanWithoutMatchLinkPredicate does.
//
// `retired_at IS NULL` is not redundant with the class filter: retireEnrichFailure PRESERVES
// review_class on purpose (for audit), so a retired row still looks actionable here. It is
// held out of the pools by the retired clause, not by the lock — unlocking it would stamp
// unlocked_at and reset the backoff for a retry that can never run, silently spending the
// row's one bet and leaving it in-flight forever, since beat 2 needs a failure that never
// comes. 3 such rows exist on prod today.
export function listLockedRows(db: DB): { beer_id: number; issue_number: number }[] {
  return db
    .prepare(
      `SELECT beer_id, issue_number FROM enrich_failures
        WHERE review_class IN ('matcher_bug', 'parser_bug')
          AND issue_number IS NOT NULL
          AND unlocked_at IS NULL
          AND retired_at IS NULL`,
    )
    .all() as { beer_id: number; issue_number: number }[];
}

// #421 beat 1: the row is spending its post-fix free retry. The verdict is deliberately
// KEPT — we still believe it, we are testing it. recordEnrichFailure settles the bet.
export function markUnlocked(db: DB, beerId: number, atIso: string): void {
  db.prepare('UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?').run(atIso, beerId);
}

// #421: the row's triage class, or null when it has never been triaged (or has no failure
// row at all). The pool queries read this column inline; this is for the callers that hold
// only a beer id — enrichOneOrphan's second eligibility gate and /enrich/candidates — and
// need it to pick the backoff schedule (RECURRING_CLASSES).
export function reviewClassOf(db: DB, beerId: number): string | null {
  const row = db
    .prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?')
    .get(beerId) as { review_class: string | null } | undefined;
  return row ? row.review_class : null;
}

// True when the row is not a beer product at all (merch, glassware, wine, kombucha,
// bundles and mystery boxes). The only class that excludes an orphan from the enrich
// pools: every other verdict is a statement about our current resolving power and can
// be overturned by a shipped fix, so those rows must stay reachable (#377 part B).
export function isNotABeer(db: DB, beerId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM enrich_failures WHERE beer_id = ? AND review_class = 'not_a_beer'`,
      )
      .get(beerId) !== undefined
  );
}

// True when the METERED web fallback (#139) must not spend a request on this beer.
// Wider than isNotABeer: `parser_bug` means the query string itself is garbage, so
// searching the web with the same wrong string cannot help; `not_on_untappd` means a
// probe already established the page does not exist; `unidentifiable` means we cannot
// say WHICH beer is meant, and the paid quota should not be spent on the population
// whose verdicts we trust least — revisit once #349's ambiguity guard lands, since
// that guard is precisely what would make an ambiguous row safe to resolve from the
// web; `retired_at` means a shipped fix already resolved the row. The free Algolia
// retry keeps running for all of these — only the paid path is tightened (#351).
export function isWebFallbackBlocked(db: DB, beerId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM enrich_failures
          WHERE beer_id = ?
            AND (review_class IN ('not_a_beer', 'unidentifiable', 'parser_bug', 'not_on_untappd')
                 OR retired_at IS NOT NULL)`,
      )
      .get(beerId) !== undefined
  );
}

// Values must stay in sync with the CHECK on enrich_failures.review_class (migration 24).
// Derived from REVIEW_CLASSES rather than repeated: the two lists silently diverging is
// exactly how `wontfix` ended up meaning two different things.
export type ReviewClass = (typeof REVIEW_CLASSES)[number];

export type SetReviewResult =
  | 'written'
  | 'no_row'
  | 'refused_unaskable'
  | 'refused_unproved_absence';

// The single write site for a triage verdict: the LLM job and the admin route both
// go through here, so a rule added here binds both. Raw bulk SQL does NOT come
// through here — that is why the "no verdict on an unaskable row" rule ALSO exists
// as a table CHECK (migration 24). This function turns that constraint violation
// into a countable refusal instead of an exception.
//
// `evidence.absenceProved` defaults to false so the safe answer is the default one:
// a caller that has not looked cannot accidentally assert absence. The admin route
// deliberately never sets it.
export function setEnrichFailureReview(
  db: DB,
  beerId: number,
  reviewClass: ReviewClass,
  note: string | null,
  atIso: string,
  issueNumber: number | null = null,
  evidence: { absenceProved: boolean } = { absenceProved: false },
): SetReviewResult {
  const existing = db
    .prepare('SELECT outcome FROM enrich_failures WHERE beer_id = ?')
    .get(beerId) as { outcome: string } | undefined;
  if (!existing) return 'no_row';
  if (existing.outcome !== 'not_found') return 'refused_unaskable';
  if (reviewClass === 'not_on_untappd' && !evidence.absenceProved) {
    return 'refused_unproved_absence';
  }

  const info = db
    .prepare(
      `UPDATE enrich_failures
         SET review_class = ?, review_note = ?, reviewed_at = ?, issue_number = ?
       WHERE beer_id = ?`,
    )
    .run(reviewClass, note, atIso, issueNumber, beerId);
  return info.changes > 0 ? 'written' : 'no_row';
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
