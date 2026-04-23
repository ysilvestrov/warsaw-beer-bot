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

export interface BeerRow extends BeerInput { id: number; }

export function upsertBeer(db: DB, b: BeerInput): number {
  const existing = db
    .prepare('SELECT id FROM beers WHERE normalized_brewery = ? AND normalized_name = ?')
    .get(b.normalized_brewery, b.normalized_name) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE beers SET untappd_id = COALESCE(?, untappd_id), name = ?, brewery = ?,
         style = ?, abv = ?, rating_global = ? WHERE id = ?`,
    ).run(b.untappd_id ?? null, b.name, b.brewery, b.style ?? null,
          b.abv ?? null, b.rating_global ?? null, existing.id);
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
