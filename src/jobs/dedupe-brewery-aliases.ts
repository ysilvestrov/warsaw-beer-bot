import type pino from 'pino';
import type { DB } from '../storage/db';
import { breweryAliases } from '../domain/matcher';

interface PairCandidate {
  canonical_id: number;
  canonical_brewery: string;
  orphan_id: number;
  orphan_norm_brewery: string;
}

export interface DedupeResult {
  pairsMerged: number;
  beersDeleted: number;
}

export function dedupeBreweryAliases(db: DB, log: pino.Logger): DedupeResult {
  // Find candidates: same normalized_name, A has untappd_id + slash, B has neither.
  // Return brewery raw so we can compute aliases in JS (SQLite has no JS regex).
  const candidates = db
    .prepare(
      `SELECT
         a.id AS canonical_id,
         a.brewery AS canonical_brewery,
         b.id AS orphan_id,
         b.normalized_brewery AS orphan_norm_brewery
       FROM beers a
       JOIN beers b
         ON a.normalized_name = b.normalized_name
        AND a.id <> b.id
       WHERE a.untappd_id IS NOT NULL
         AND b.untappd_id IS NULL
         AND a.brewery LIKE '% / %'
       ORDER BY a.id, b.id`,
    )
    .all() as PairCandidate[];

  // Filter to pairs where the orphan brewery actually overlaps an alias of canonical.
  // Group by orphan_id to ensure each orphan is merged into its earliest canonical.
  const pairsByOrphan = new Map<number, PairCandidate>();
  for (const c of candidates) {
    const aliases = new Set(breweryAliases(c.canonical_brewery));
    if (!aliases.has(c.orphan_norm_brewery)) continue;
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
  log.info(
    { pairs: merged },
    'dedupe-brewery-aliases: merged orphan ontap rows into canonical Untappd rows',
  );
  return { pairsMerged: merged, beersDeleted: merged };
}
