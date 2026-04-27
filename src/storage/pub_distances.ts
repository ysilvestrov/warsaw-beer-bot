import type { DB } from './db';

export type DistanceSource = 'osrm' | 'haversine';

export interface CachedDistance {
  meters: number;
  source: DistanceSource;
}

function order(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

export function getDistance(db: DB, idA: number, idB: number): CachedDistance | null {
  if (idA === idB) return { meters: 0, source: 'osrm' };
  const [lo, hi] = order(idA, idB);
  const row = db
    .prepare('SELECT meters, source FROM pub_distances WHERE pub_id_a = ? AND pub_id_b = ?')
    .get(lo, hi) as { meters: number; source: DistanceSource } | undefined;
  return row ?? null;
}

export function putDistance(
  db: DB,
  idA: number,
  idB: number,
  meters: number,
  source: DistanceSource,
): void {
  if (idA === idB) return;
  const [lo, hi] = order(idA, idB);
  db.prepare(
    `INSERT INTO pub_distances (pub_id_a, pub_id_b, meters, source, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(pub_id_a, pub_id_b) DO UPDATE
       SET meters = excluded.meters,
           source = excluded.source,
           updated_at = excluded.updated_at`,
  ).run(lo, hi, meters, source);
}

export function putDistances(
  db: DB,
  rows: { idA: number; idB: number; meters: number; source: DistanceSource }[],
): void {
  const tx = db.transaction(() => {
    for (const r of rows) putDistance(db, r.idA, r.idB, r.meters, r.source);
  });
  tx();
}

export function getDistancesFor(db: DB, pubIds: number[]): Map<string, CachedDistance> {
  const out = new Map<string, CachedDistance>();
  if (pubIds.length < 2) return out;
  const ids = [...new Set(pubIds)];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT pub_id_a, pub_id_b, meters, source FROM pub_distances
        WHERE pub_id_a IN (${placeholders}) AND pub_id_b IN (${placeholders})`,
    )
    .all(...ids, ...ids) as { pub_id_a: number; pub_id_b: number; meters: number; source: DistanceSource }[];
  for (const r of rows) {
    out.set(pairKey(r.pub_id_a, r.pub_id_b), { meters: r.meters, source: r.source });
  }
  return out;
}

export function pairKey(idA: number, idB: number): string {
  const [lo, hi] = order(idA, idB);
  return `${lo}:${hi}`;
}

export function clearForPub(db: DB, pubId: number): void {
  db.prepare('DELETE FROM pub_distances WHERE pub_id_a = ? OR pub_id_b = ?').run(pubId, pubId);
}
