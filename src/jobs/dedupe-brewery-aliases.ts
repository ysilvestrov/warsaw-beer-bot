import type pino from 'pino';
import type { DB } from '../storage/db';
import { breweryAliases } from '../domain/matcher';
import { bumpCatalogVersion } from '../storage/catalog-version';

interface PairCandidate {
  canonical_id: number;
  canonical_brewery: string;
  orphan_id: number;
  orphan_brewery: string;
}

export interface DedupeResult {
  pairsMerged: number;
  beersDeleted: number;
}

export function dedupeBreweryAliases(db: DB, log: pino.Logger): DedupeResult {
  // Find candidates: same normalized_name, A has untappd_id and B doesn't.
  // Compound brewery form ("X/Y" slash, any spacing, or "X (Y)" paren) may
  // appear on EITHER side of the pair — PR-A had it on canonical (Kemker
  // (Brauerei J. Kemker)), PR-C had it on orphan (Sady/Beer Bacon and
  // Liberty Brewery). Match either; JS alias-overlap will decide whether
  // the pair actually corresponds.
  const candidates = db
    .prepare(
      `SELECT
         a.id AS canonical_id,
         a.brewery AS canonical_brewery,
         b.id AS orphan_id,
         b.brewery AS orphan_brewery
       FROM beers a
       JOIN beers b
         ON a.normalized_name = b.normalized_name
        AND a.id <> b.id
       WHERE a.untappd_id IS NOT NULL
         AND b.untappd_id IS NULL
         AND (
           a.brewery LIKE '%/%'
           OR (a.brewery LIKE '%(%' AND a.brewery LIKE '%)%')
           OR b.brewery LIKE '%/%'
           OR (b.brewery LIKE '%(%' AND b.brewery LIKE '%)%')
         )
       ORDER BY a.id, b.id`,
    )
    .all() as PairCandidate[];

  // Symmetric alias-overlap: pair merges only if breweryAliases(canonical)
  // and breweryAliases(orphan) share at least one element. This filters out
  // false-positives where the SQL pre-filter caught a pair that happens to
  // share normalized_name but whose breweries are unrelated.
  const pairsByOrphan = new Map<number, PairCandidate>();
  for (const c of candidates) {
    const canonicalAliases = new Set(breweryAliases(c.canonical_brewery));
    const orphanAliases = breweryAliases(c.orphan_brewery);
    const overlap = orphanAliases.some((x) => canonicalAliases.has(x));
    if (!overlap) continue;
    if (!pairsByOrphan.has(c.orphan_id)) pairsByOrphan.set(c.orphan_id, c);
  }

  if (pairsByOrphan.size === 0) {
    log.info({ pairs: 0 }, 'dedupe-brewery-aliases: catalog clean');
    return { pairsMerged: 0, beersDeleted: 0 };
  }

  const updateLinks = db.prepare(
    'UPDATE match_links SET untappd_beer_id = ? WHERE untappd_beer_id = ?',
  );
  const updateCheckins = db.prepare(
    'UPDATE checkins SET beer_id = ? WHERE beer_id = ?',
  );
  const deleteBeer = db.prepare('DELETE FROM beers WHERE id = ?');

  const tx = db.transaction((pairs: PairCandidate[]) => {
    for (const p of pairs) {
      updateLinks.run(p.canonical_id, p.orphan_id);
      updateCheckins.run(p.canonical_id, p.orphan_id);
      deleteBeer.run(p.orphan_id);
    }
  });
  tx(Array.from(pairsByOrphan.values()));

  const merged = pairsByOrphan.size;
  if (merged > 0) bumpCatalogVersion();
  log.info(
    { pairs: merged },
    'dedupe-brewery-aliases: merged orphan ontap rows into canonical Untappd rows',
  );
  return { pairsMerged: merged, beersDeleted: merged };
}
