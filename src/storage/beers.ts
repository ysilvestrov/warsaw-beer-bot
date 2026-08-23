import type { DB } from './db';
import { bumpCatalogVersion } from './catalog-version';

export type UntappdIdSource = 'search' | 'bid' | 'curated' | 'checkin';

// #384: a stored link may be replaced by a shop-published bid only when WE put it there
// by guessing. 'curated' is a human decision; 'checkin' is Untappd's own record. The same
// list keeps a bid from *weakening* either stamp when it merely confirms the link.
export const PROVENANCE_REFUSING_OVERRIDE: readonly UntappdIdSource[] = ['curated', 'checkin'];

export function refusesBidOverride(source: string | null | undefined): boolean {
  return (PROVENANCE_REFUSING_OVERRIDE as readonly string[]).includes(source ?? '');
}

// Stamps 'bid' on whichever row now owns this untappd_id (the enriched row, or the
// canonical row it was merged into). untappd_id is UNIQUE, so this touches one row.
export function stampBidProvenance(db: DB, bid: number): void {
  const holes = PROVENANCE_REFUSING_OVERRIDE.map(() => '?').join(', ');
  db.prepare(
    `UPDATE beers SET untappd_id_source = 'bid'
       WHERE untappd_id = ? AND COALESCE(untappd_id_source, '') NOT IN (${holes})`,
  ).run(bid, ...PROVENANCE_REFUSING_OVERRIDE);
}

export interface BeerInput {
  untappd_id?: number | null;
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
  /** #384: provenance of untappd_id. Omitted leaves any existing value untouched. */
  untappd_id_source?: UntappdIdSource;
}

export interface BeerRow extends BeerInput {
  id: number;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
  rating_refresh_at: string | null;
  rating_refresh_count: number;
  web_tried_at: string | null;
}

export function upsertBeer(db: DB, b: BeerInput): number {
  // Prefer match by untappd_id when provided — it's authoritative and
  // survives normalization drift across code versions or upstream renames.
  // A normalized-only lookup caused UNIQUE violations on re-import when a
  // row had the bid we're assigning but stored under a stale normalized form.
  let existing: { id: number } | undefined;
  if (b.untappd_id != null) {
    existing = db
      .prepare('SELECT id FROM beers WHERE untappd_id = ?')
      .get(b.untappd_id) as { id: number } | undefined;
  }
  if (!existing) {
    existing = db
      .prepare('SELECT id FROM beers WHERE normalized_brewery = ? AND normalized_name = ?')
      .get(b.normalized_brewery, b.normalized_name) as { id: number } | undefined;
  }

  if (existing) {
    db.prepare(
      `UPDATE beers SET untappd_id = COALESCE(?, untappd_id), name = ?, brewery = ?,
         style = ?, abv = ?, rating_global = ?,
         normalized_name = ?, normalized_brewery = ?,
         untappd_id_source = COALESCE(?, untappd_id_source) WHERE id = ?`,
    ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null,
          b.abv ?? null, b.rating_global ?? null,
          b.normalized_name, b.normalized_brewery,
          b.untappd_id_source ?? null, existing.id);
    bumpCatalogVersion();
    return existing.id;
  }

  const res = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
       normalized_name, normalized_brewery, untappd_id_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null, b.abv ?? null,
        b.rating_global ?? null, b.normalized_name, b.normalized_brewery,
        b.untappd_id_source ?? null);
  bumpCatalogVersion();
  return Number(res.lastInsertRowid);
}

// #369: one place decides whether a relayed ABV is usable. Kept permissive on
// purpose — 0 is a real value (a 0.0% beer, the #322 disambiguator), and the upper
// bound is a garbage filter, not a domain limit (freeze-distilled beers reach ~67%).
export function sanitizeAbv(abv: number | undefined): number | undefined {
  if (abv === undefined) return undefined;
  if (!Number.isFinite(abv)) return undefined;
  if (abv < 0 || abv > 100) return undefined;
  return abv;
}

export interface OrphanFacts {
  abv?: number;
  style?: string;
}

export interface FillResult {
  /** An orphan row gained an ABV it did not have — the caller should re-arm its backoff. */
  abvGained: boolean;
  /** Any column was written. */
  changed: boolean;
}

// #369: shop-published facts for a beer that arrived over the extension relay.
// Fills ONLY columns that are currently NULL, and ONLY on orphan rows: a matched
// row's abv/style belong to Untappd, matching is already done, and a shop value
// could only introduce drift. Never overwrites.
export function fillOrphanFacts(db: DB, beerId: number, facts: OrphanFacts): FillResult {
  const none: FillResult = { abvGained: false, changed: false };
  const abv = sanitizeAbv(facts.abv);
  const style = facts.style;
  if (abv === undefined && style === undefined) return none;

  const row = db
    .prepare('SELECT untappd_id, abv, style FROM beers WHERE id = ?')
    .get(beerId) as { untappd_id: number | null; abv: number | null; style: string | null } | undefined;
  if (!row || row.untappd_id != null) return none;

  const abvGained = row.abv == null && abv !== undefined;
  const styleGained = row.style == null && style !== undefined;
  if (!abvGained && !styleGained) return none;

  db.prepare('UPDATE beers SET abv = COALESCE(abv, ?), style = COALESCE(style, ?) WHERE id = ?')
    .run(abvGained ? abv : null, styleGained ? style : null, beerId);
  bumpCatalogVersion();
  return { abvGained, changed: true };
}

// #369: a row that just gained an ABV deserves an immediate retry — the previous
// lookup ran blind, which is the whole bug. Resets the backoff so isEligible()
// returns true at once. isNotABeer still gates eligibility separately.
export function rearmLookup(db: DB, beerId: number): void {
  db.prepare('UPDATE beers SET untappd_lookup_at = NULL, untappd_lookup_count = 0 WHERE id = ?')
    .run(beerId);
}

export interface CatalogRow {
  id: number;
  brewery: string;
  name: string;
  abv: number | null;
  rating_global: number | null;
  untappd_id: number | null;
}

export function loadCatalog(db: DB): CatalogRow[] {
  return db
    .prepare('SELECT id, brewery, name, abv, rating_global, untappd_id FROM beers')
    .all() as CatalogRow[];
}

export function findBeerByNormalized(
  db: DB, normBrewery: string, normName: string,
): BeerRow | null {
  const row = db
    .prepare('SELECT * FROM beers WHERE normalized_brewery = ? AND normalized_name = ?')
    .get(normBrewery, normName) as BeerRow | undefined;
  return row ?? null;
}

export function getBeer(db: DB, beerId: number): BeerRow | null {
  const row = db
    .prepare('SELECT * FROM beers WHERE id = ?')
    .get(beerId) as BeerRow | undefined;
  return row ?? null;
}

export function recordLookupSuccess(
  db: DB,
  beerId: number,
  r: {
    bid: number;
    style: string | null;
    abv: number | null;
    global_rating: number | null;
  },
  at: string,
): void {
  db.prepare(
    `UPDATE beers SET
       untappd_id = ?,
       untappd_id_source = 'search',
       style = COALESCE(?, style),
       abv = COALESCE(?, abv),
       rating_global = COALESCE(?, rating_global),
       untappd_lookup_at = ?
     WHERE id = ?`,
  ).run(r.bid, r.style, r.abv, r.global_rating, at, beerId);
  bumpCatalogVersion();
}

// Merges an orphan beer into a canonical catalog entry by redirecting all match_links and
// deleting the orphan. Called when recordLookupSuccess hits a UNIQUE constraint (the found
// untappd_id already belongs to another row).
export function mergeIntoCanonical(db: DB, orphanId: number, canonicalId: number, at: string): void {
  db.transaction(() => {
    // #366: the merge is the only moment we learn "this ontap_ref is that canonical beer".
    // The stamp keeps that knowledge past the next ingest; without it refreshOntap recomputes,
    // misses again (that is why the row needed a merge) and re-creates the orphan — ~65 wasted
    // Untappd lookups a day, plus repeat metered web-fallback calls.
    // Only an exact/parser-choice link (confidence 1.0) carries evidence: its own tap text is
    // what the lookup resolved. A fuzzy satellite (<1) was a matcher guess about the orphan, so
    // it is redirected like before but NOT made durable — it keeps re-orphaning and gets looked
    // up on its own text, which is the more accurate answer.
    db.prepare(
      'UPDATE match_links SET untappd_beer_id = ?, merged_at = ? WHERE untappd_beer_id = ? AND confidence >= 1.0',
    ).run(canonicalId, at, orphanId);
    db.prepare('UPDATE match_links SET untappd_beer_id = ? WHERE untappd_beer_id = ?')
      .run(canonicalId, orphanId);
    // checkins.beer_id → beers(id) has NO ON DELETE CASCADE and foreign_keys=ON, so a check-in
    // on the orphan would abort the DELETE. Point it at the canonical row first (as pinMatch does).
    db.prepare('UPDATE checkins SET beer_id = ? WHERE beer_id = ?').run(canonicalId, orphanId);
    db.prepare('DELETE FROM beers WHERE id = ?').run(orphanId);
  })();
  bumpCatalogVersion();
}

export function recordLookupNotFound(db: DB, beerId: number, at: string): void {
  db.prepare(
    `UPDATE beers SET
       untappd_lookup_at = ?,
       untappd_lookup_count = untappd_lookup_count + 1
     WHERE id = ?`,
  ).run(at, beerId);
}

export function recordLookupTransient(
  db: DB,
  beerId: number,
  at: string,
): void {
  db.prepare(
    'UPDATE beers SET untappd_lookup_at = ? WHERE id = ?',
  ).run(at, beerId);
}

import { isEligible, RECURRING_CLASSES } from '../domain/lookup-backoff';

export interface LookupCandidate {
  id: number;
  brewery: string;
  name: string;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
  // #421: the backoff schedule differs by class — `not_on_untappd` waits on Untappd's
  // catalogue growing and so repeats its last delay forever, while every other class
  // keeps the terminal schedule. Selected here so the pool query stays the single place
  // that reads enrich_failures for a candidate.
  review_class: string | null;
}

// #421: a verdict that names an unfixed bug is a settled question — while the issue is
// open the answer cannot move, so re-asking Untappd spends quota on nothing AND burns the
// row's four backoff attempts before its fix ships. The row is held out of both pools
// until `unlock-fixed-orphans` sees its issue leave the open set and stamps `unlocked_at`.
//
// Three conditions, each load-bearing: the class must name a fix owner (only matcher_bug
// and parser_bug do), the row must name WHICH fix (`issue_number`, v23 — a verdict with no
// issue could never be unlocked, so locking it would be a permanent seal, the very thing
// #377 spent a design removing), and the free retry must not already be spent.
//
// Deliberately NOT applied in two places. `/enrich/candidates` searches in the user's own
// Untappd session (#89), so the quota this saves is not ours to save and a locked row may
// still be findable there. `orphansOffCron` in stats.ts counts the whole drain QUEUE, not
// the slice eligible right now — which is why it already skips the backoff filter too;
// hiding locked rows there would make the backlog look like it shrank when it only went
// quiet. Hence this is appended at the two pool call sites rather than folded into
// orphanNotOnTapPredicate, which stats.ts shares.
//
// Assumes the `beers` alias `b`, like orphanNotOnTapPredicate.
export const lockedRowPredicate = `EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND ef.review_class IN ('matcher_bug', 'parser_bug')
             AND ef.issue_number IS NOT NULL
             AND ef.unlocked_at IS NULL
         )`;

// #486: the single definition of "this beer is on a tap right now" — a `match_links` row
// reaching a tap on some pub's LATEST snapshot. `listLookupCandidates` interpolates it as-is;
// `orphanNotOnTapPredicate` below interpolates its negation, which is what makes the two pools
// a partition rather than two conditions that merely looked complementary. Bakes in the `beers`
// alias `b`, like the fragments around it; WHERE-clause fragment only.
export const onLatestTapPredicate = `EXISTS (
           SELECT 1 FROM match_links ml
           JOIN taps t ON t.beer_ref = ml.ontap_ref
           JOIN tap_snapshots ts ON ts.id = t.snapshot_id
           JOIN (
             SELECT pub_id, MAX(snapshot_at) AS m
             FROM tap_snapshots
             GROUP BY pub_id
           ) latest ON latest.pub_id = ts.pub_id
                  AND latest.m = ts.snapshot_at
           WHERE ml.untappd_beer_id = b.id
         )`;

export function listLookupCandidates(
  db: DB,
  limit: number,
  now: Date,
): LookupCandidate[] {
  // SQL pre-filter: orphan beers (untappd_id NULL) whose beer_id is on the
  // latest snapshot of at least one pub, excluding ones triaged as `not_a_beer`
  // (merch, bundles, wine — re-querying a T-shirt can never match) or retired
  // (provably resolved by a shipped fix — re-querying is dead work).
  // #377 part B: `not_a_beer` is the ONLY verdict that removes a row from a pool.
  // Every other class is a statement about what we can resolve TODAY and is
  // overturned by shipped fixes, so those rows must stay reachable — otherwise the
  // 0<->>0 auto-unseal in recordEnrichFailure can never fire, because the seal is
  // what keeps the row away from the lookup that would lift it.
  const rows = db
    .prepare(
      `SELECT b.id, b.brewery, b.name,
              b.untappd_lookup_at, b.untappd_lookup_count,
              (SELECT ef.review_class FROM enrich_failures ef WHERE ef.beer_id = b.id)
                AS review_class
       FROM beers b
       WHERE b.untappd_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND (ef.review_class = 'not_a_beer' OR ef.retired_at IS NOT NULL)
         )
         AND NOT ${lockedRowPredicate}
         AND ${onLatestTapPredicate}
       ORDER BY b.untappd_lookup_count ASC, b.id ASC`,
    )
    .all() as LookupCandidate[];

  // JS-side backoff filter (isEligible lives in lookup-backoff; reproducing
  // its math in SQLite julianday arithmetic would duplicate the schedule
  // and drift over time).
  const eligible = rows.filter((r) =>
    isEligible(now, r.untappd_lookup_at, r.untappd_lookup_count,
      RECURRING_CLASSES.includes(r.review_class ?? '')),
  );

  return eligible.slice(0, limit);
}

// #368/#486: shared WHERE predicate — "orphan that is NOT on a tap right now" (untappd_id
// IS NULL, minus not_a_beer/retired, minus anything currently on a latest-snapshot tap). Used
// by listRelayLookupCandidates below (the drain query) AND by orphansRelayQueue in stats.ts
// (the digest metric), so the two can't silently diverge if one is edited later. Bakes in `b`
// as the `beers` table alias — every call site must FROM/JOIN beers AS b. Fragment only, no
// WHERE keyword/SELECT/ORDER BY/LIMIT — each caller keeps owning its own query shape. The
// digest metric interpolates this as-is and deliberately skips the JS-side backoff filter
// (isEligible) applied below: it counts the whole drain queue, not just the slice eligible to
// query right now.
//
// #486: the third clause is the NEGATION of onLatestTapPredicate, not an independent test.
// It used to be `NOT EXISTS(match_links)`, which is strictly narrower — a beer whose link no
// longer reaches a latest-snapshot tap satisfied neither pool and became unreachable by any
// cron. spec.md called that deliberate; it cost 462 of 911 orphans, 376 of them never queried
// once. Writing it as the negation makes the partition a property of the construction.
export const orphanNotOnTapPredicate = `b.untappd_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND (ef.review_class = 'not_a_beer' OR ef.retired_at IS NOT NULL)
         )
         AND NOT ${onLatestTapPredicate}`;

// #368: relay-пул — orphan'и, яких on-tap пул не побачить НІКОЛИ. Рядки, намінчені
// `/enrich/candidates` (ensureBeerRow біжить по кожній картці сторінки крамниці), не
// отримують рядка в `match_links`, бо лінки пише лише on-tap ingest. Тому клауза
// EXISTS(match_links → taps → latest snapshot) у listLookupCandidates виключає їх
// структурно, а не тому, що вони зійшли з кранів. Виключення not_a_beer/retired, backoff
// і сортування — ті самі; інвертований предикат робить пули диз'юнктними за
// побудовою (дедуп не потрібен), але НЕ покриває orphan'а з рядком у match_links,
// чий кран зійшов з останнього снапшоту — той не потрапляє в жоден пул.
export function listRelayLookupCandidates(
  db: DB,
  limit: number,
  now: Date,
): LookupCandidate[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.brewery, b.name,
              b.untappd_lookup_at, b.untappd_lookup_count,
              (SELECT ef.review_class FROM enrich_failures ef WHERE ef.beer_id = b.id)
                AS review_class
       FROM beers b
       WHERE ${orphanNotOnTapPredicate}
         AND NOT ${lockedRowPredicate}
       ORDER BY b.untappd_lookup_count ASC, b.id ASC`,
    )
    .all() as LookupCandidate[];

  // Той самий JS-фільтр backoff, що й у listLookupCandidates: відтворювати його
  // математику в julianday-арифметиці SQLite означало б дублювати розклад.
  const eligible = rows.filter((r) =>
    isEligible(now, r.untappd_lookup_at, r.untappd_lookup_count,
      RECURRING_CLASSES.includes(r.review_class ?? '')),
  );

  return eligible.slice(0, limit);
}

export function recordRatingSuccess(
  db: DB,
  beerId: number,
  rating: number,
): void {
  // Success overwrites whatever rating_global was there. Count not touched —
  // the beer leaves the candidate pool naturally (rating_global IS NOT NULL).
  db.prepare('UPDATE beers SET rating_global = ? WHERE id = ?')
    .run(rating, beerId);
  bumpCatalogVersion();
}

export function recordRatingNotFound(
  db: DB,
  beerId: number,
  at: string,
): void {
  db.prepare(
    `UPDATE beers SET
       rating_refresh_at = ?,
       rating_refresh_count = rating_refresh_count + 1
     WHERE id = ?`,
  ).run(at, beerId);
}

export function recordRatingTransient(
  db: DB,
  beerId: number,
  at: string,
): void {
  db.prepare(
    'UPDATE beers SET rating_refresh_at = ? WHERE id = ?',
  ).run(at, beerId);
}

export interface RatingRefreshCandidate {
  id: number;
  untappd_id: number;
  rating_refresh_at: string | null;
  rating_refresh_count: number;
}

export function listRatingRefreshCandidates(
  db: DB,
  limit: number,
  now: Date,
): RatingRefreshCandidate[] {
  // SQL pre-filter: beers WITH untappd_id but NO rating, currently on tap.
  // Same on-tap join as listLookupCandidates.
  const rows = db
    .prepare(
      `SELECT b.id, b.untappd_id,
              b.rating_refresh_at, b.rating_refresh_count
       FROM beers b
       WHERE b.untappd_id IS NOT NULL
         AND b.rating_global IS NULL
         AND EXISTS (
           SELECT 1 FROM match_links ml
           JOIN taps t ON t.beer_ref = ml.ontap_ref
           JOIN tap_snapshots ts ON ts.id = t.snapshot_id
           JOIN (
             SELECT pub_id, MAX(snapshot_at) AS m
             FROM tap_snapshots
             GROUP BY pub_id
           ) latest ON latest.pub_id = ts.pub_id
                  AND latest.m = ts.snapshot_at
           WHERE ml.untappd_beer_id = b.id
         )
       ORDER BY b.rating_refresh_count ASC, b.id ASC`,
    )
    .all() as RatingRefreshCandidate[];

  // JS-side backoff filter using the shared lookup-backoff module.
  const eligible = rows.filter((r) =>
    isEligible(now, r.rating_refresh_at, r.rating_refresh_count),
  );

  return eligible.slice(0, limit);
}

export function readWebTriedAt(db: DB, beerId: number): string | null {
  const row = db
    .prepare('SELECT web_tried_at FROM beers WHERE id = ?')
    .get(beerId) as { web_tried_at: string | null } | undefined;
  return row?.web_tried_at ?? null;
}

export function stampWebTried(db: DB, beerId: number, iso: string): void {
  db.prepare('UPDATE beers SET web_tried_at = ? WHERE id = ?').run(iso, beerId);
}
