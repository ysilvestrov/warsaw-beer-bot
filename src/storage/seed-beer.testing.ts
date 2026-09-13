import type { DB } from './db';
import { bumpCatalogVersion } from './catalog-version';
import type { BeerInput } from './beers';

// #617: ТІЛЬКИ ДЛЯ ТЕСТІВ. Стара upsertBeer: шукає рядок за untappd_id, інакше за нормалізованою
// парою, і БЕЗУМОВНО перезаписує поля. У продакшні саме це стирало рейтинги синком і переписувало
// bid вінтаж-близнюка, тому продакшн-код ходить через upsertBeerByBid / ensureOrphan, а цей сід
// лишено тестам, яким потрібен довільний рядок. Страж — seed-beer-guard.test.ts.
export function seedBeer(db: DB, b: BeerInput): number {
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
