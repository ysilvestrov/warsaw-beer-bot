import type { DB } from './db';

export interface BeerInput {
  untappd_id?: number | null;
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
}

export interface BeerRow extends BeerInput {
  id: number;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
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
         normalized_name = ?, normalized_brewery = ? WHERE id = ?`,
    ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null,
          b.abv ?? null, b.rating_global ?? null,
          b.normalized_name, b.normalized_brewery, existing.id);
    return existing.id;
  }

  const res = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
       normalized_name, normalized_brewery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null, b.abv ?? null,
        b.rating_global ?? null, b.normalized_name, b.normalized_brewery);
  return Number(res.lastInsertRowid);
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
): void {
  db.prepare(
    `UPDATE beers SET
       untappd_id = ?,
       style = COALESCE(?, style),
       abv = COALESCE(?, abv),
       rating_global = COALESCE(?, rating_global)
     WHERE id = ?`,
  ).run(r.bid, r.style, r.abv, r.global_rating, beerId);
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

import { isEligible } from '../domain/lookup-backoff';

export interface LookupCandidate {
  id: number;
  brewery: string;
  name: string;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
}

export function listLookupCandidates(
  db: DB,
  limit: number,
  now: Date,
): LookupCandidate[] {
  // SQL pre-filter: orphan beers (untappd_id NULL) whose beer_id is on the
  // latest snapshot of at least one pub.
  const rows = db
    .prepare(
      `SELECT b.id, b.brewery, b.name,
              b.untappd_lookup_at, b.untappd_lookup_count
       FROM beers b
       WHERE b.untappd_id IS NULL
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
       ORDER BY b.untappd_lookup_count ASC, b.id ASC`,
    )
    .all() as LookupCandidate[];

  // JS-side backoff filter (isEligible lives in lookup-backoff; reproducing
  // its math in SQLite julianday arithmetic would duplicate the schedule
  // and drift over time).
  const eligible = rows.filter((r) =>
    isEligible(now, r.untappd_lookup_at, r.untappd_lookup_count),
  );

  return eligible.slice(0, limit);
}
