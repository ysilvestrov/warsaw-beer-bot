import type pino from 'pino';
import type { DB } from '../storage/db';
import { extractBeerName } from '../sources/ontap/pub';
import { matchBeer, type CatalogBeer } from '../domain/matcher';
import { normalizeName } from '../domain/normalize';

const POLLUTION_RE = /\d+(?:[.,]\d+)?\s*[°%]| — /;
const MERGE_THRESHOLD = 0.9;

interface BeerRow extends CatalogBeer {
  normalized_name: string;
  untappd_id: number | null;
}

export interface CleanupResult {
  rewritten: number;
  merged: number;
}

interface MergePlan { kind: 'merge'; pollutedId: number; targetId: number }
interface RewritePlan { kind: 'rewrite'; pollutedId: number; cleaned: string; cleanedNormalized: string }
type Plan = MergePlan | RewritePlan;

export function cleanupPollutedOntap(db: DB, log: pino.Logger): CleanupResult {
  const allOntap = db
    .prepare(
      `SELECT id, name, brewery, abv, normalized_name, untappd_id
         FROM beers
        WHERE untappd_id IS NULL`,
    )
    .all() as BeerRow[];

  const pollutedIds = new Set<number>();
  const polluted: BeerRow[] = [];
  for (const r of allOntap) {
    if (POLLUTION_RE.test(r.name)) {
      polluted.push(r);
      pollutedIds.add(r.id);
    }
  }

  if (polluted.length === 0) {
    log.info({ polluted: 0 }, 'cleanup-polluted-ontap: catalog clean');
    return { rewritten: 0, merged: 0 };
  }

  const cleanPool = db
    .prepare('SELECT id, name, brewery, abv FROM beers')
    .all() as CatalogBeer[];
  const pool = cleanPool.filter((c) => !pollutedIds.has(c.id));

  const plans: Plan[] = [];
  for (const p of polluted) {
    const cleaned = extractBeerName(p.name, p.brewery);
    if (!cleaned) continue;
    const cleanedNorm = normalizeName(cleaned);
    if (cleanedNorm === p.normalized_name) continue;

    const match = matchBeer({ brewery: p.brewery, name: cleaned, abv: p.abv }, pool);
    if (match && match.confidence >= MERGE_THRESHOLD) {
      plans.push({ kind: 'merge', pollutedId: p.id, targetId: match.id });
    } else {
      plans.push({ kind: 'rewrite', pollutedId: p.id, cleaned, cleanedNormalized: cleanedNorm });
    }
  }

  const updateLinks = db.prepare(
    'UPDATE match_links SET untappd_beer_id = ? WHERE untappd_beer_id = ?',
  );
  const updateCheckins = db.prepare(
    'UPDATE checkins SET beer_id = ? WHERE beer_id = ?',
  );
  const deleteBeer = db.prepare('DELETE FROM beers WHERE id = ?');
  const rewriteName = db.prepare(
    'UPDATE beers SET name = ?, normalized_name = ? WHERE id = ?',
  );

  let rewritten = 0;
  let merged = 0;
  const tx = db.transaction((items: Plan[]) => {
    for (const plan of items) {
      if (plan.kind === 'merge') {
        updateLinks.run(plan.targetId, plan.pollutedId);
        updateCheckins.run(plan.targetId, plan.pollutedId);
        deleteBeer.run(plan.pollutedId);
        merged++;
      } else {
        rewriteName.run(plan.cleaned, plan.cleanedNormalized, plan.pollutedId);
        rewritten++;
      }
    }
  });
  tx(plans);

  log.info({ rewritten, merged }, 'cleanup-polluted-ontap: pass complete');
  return { rewritten, merged };
}
