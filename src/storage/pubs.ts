import type { DB } from './db';

export interface PubInput {
  slug: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
}

export interface PubRow extends PubInput { id: number; }

export function upsertPub(db: DB, p: PubInput): number {
  const existing = db.prepare('SELECT id FROM pubs WHERE slug = ?').get(p.slug) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE pubs SET name = ?, address = COALESCE(?, address),
         lat = COALESCE(?, lat), lon = COALESCE(?, lon) WHERE id = ?`,
    ).run(p.name, p.address, p.lat, p.lon, existing.id);
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
}
