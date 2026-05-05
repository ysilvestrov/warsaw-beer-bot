import type { DB } from './db';

export interface TapInput {
  tap_number: number | null;
  beer_ref: string;
  brewery_ref: string | null;
  abv: number | null;
  ibu: number | null;
  style: string | null;
  u_rating: number | null;
}

export interface TapRow extends TapInput { id: number; snapshot_id: number; }
export interface SnapshotRow { id: number; pub_id: number; snapshot_at: string; }

export function createSnapshot(db: DB, pubId: number, at: string): number {
  const res = db.prepare(
    'INSERT INTO tap_snapshots (pub_id, snapshot_at) VALUES (?, ?)',
  ).run(pubId, at);
  return Number(res.lastInsertRowid);
}

export function insertTaps(db: DB, snapshotId: number, taps: TapInput[]): void {
  const stmt = db.prepare(
    `INSERT INTO taps (snapshot_id, tap_number, beer_ref, brewery_ref, abv, ibu, style, u_rating)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((items: TapInput[]) => {
    for (const t of items) {
      stmt.run(snapshotId, t.tap_number, t.beer_ref, t.brewery_ref,
               t.abv, t.ibu, t.style, t.u_rating);
    }
  });
  tx(taps);
}

export function tapsForSnapshot(db: DB, snapshotId: number): TapRow[] {
  return db.prepare('SELECT * FROM taps WHERE snapshot_id = ? ORDER BY tap_number').all(snapshotId) as TapRow[];
}

export function latestSnapshot(db: DB, pubId: number): SnapshotRow | null {
  return (db.prepare(
    'SELECT * FROM tap_snapshots WHERE pub_id = ? ORDER BY snapshot_at DESC LIMIT 1',
  ).get(pubId) as SnapshotRow | undefined) ?? null;
}

export function latestSnapshotsPerPub(db: DB): SnapshotRow[] {
  return db.prepare(
    `SELECT s.* FROM tap_snapshots s
     INNER JOIN (
       SELECT pub_id, MAX(snapshot_at) AS m FROM tap_snapshots GROUP BY pub_id
     ) x ON x.pub_id = s.pub_id AND x.m = s.snapshot_at`,
  ).all() as SnapshotRow[];
}

export interface TapWithBeer extends TapRow {
  beer_id: number | null;
  // u_rating on this row is the COALESCEd value: tap.u_rating ?? beers.rating_global ?? null
}

export function tapsForSnapshotWithBeer(db: DB, snapshotId: number): TapWithBeer[] {
  return db.prepare(`
    SELECT
      t.id, t.snapshot_id, t.tap_number, t.beer_ref, t.brewery_ref,
      t.abv, t.ibu, t.style,
      COALESCE(t.u_rating, b.rating_global) AS u_rating,
      ml.untappd_beer_id AS beer_id
    FROM taps t
    LEFT JOIN match_links ml ON t.beer_ref = ml.ontap_ref
    LEFT JOIN beers b ON ml.untappd_beer_id = b.id
    WHERE t.snapshot_id = ?
    ORDER BY t.tap_number
  `).all(snapshotId) as TapWithBeer[];
}
