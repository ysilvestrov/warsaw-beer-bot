import type { DB } from './db';
import { clearForPub } from './pub_distances';

export interface PubInput {
  slug: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
}

export interface PubRow extends PubInput { id: number; }

export function upsertPub(db: DB, p: PubInput): number {
  const existing = db
    .prepare('SELECT id, lat, lon FROM pubs WHERE slug = ?')
    .get(p.slug) as { id: number; lat: number | null; lon: number | null } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE pubs SET name = ?, address = COALESCE(?, address),
         lat = COALESCE(?, lat), lon = COALESCE(?, lon) WHERE id = ?`,
    ).run(p.name, p.address, p.lat, p.lon, existing.id);
    if (coordsChanged(existing, p)) clearForPub(db, existing.id);
    return existing.id;
  }
  const res = db.prepare(
    'INSERT INTO pubs (slug, name, address, lat, lon) VALUES (?, ?, ?, ?, ?)',
  ).run(p.slug, p.name, p.address, p.lat, p.lon);
  return Number(res.lastInsertRowid);
}

export function listPubs(db: DB): PubRow[] {
  return db.prepare('SELECT * FROM pubs ORDER BY id').all() as PubRow[];
}

export function setPubCoords(db: DB, pubId: number, lat: number, lon: number): void {
  db.prepare('UPDATE pubs SET lat = ?, lon = ? WHERE id = ?').run(lat, lon, pubId);
  clearForPub(db, pubId);
}

function coordsChanged(
  prev: { lat: number | null; lon: number | null },
  next: { lat: number | null; lon: number | null },
): boolean {
  // upsertPub uses COALESCE — null inputs keep the existing value, so they
  // never invalidate the cache.
  if (next.lat == null && next.lon == null) return false;
  return prev.lat !== next.lat || prev.lon !== next.lon;
}
