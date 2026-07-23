import type { DB } from '../storage/db';
import { bumpCatalogVersion } from '../storage/catalog-version';

export type PinResult =
  | { kind: 'merged'; canonicalId: number; redirected: number }
  | { kind: 'set'; beerId: number }
  | { kind: 'noop'; reason: string };

// Curate a durable match pin for a name-divergent orphan. Two data-model cases:
//  - the target bid already belongs to a canonical row → MERGE (redirect + pin the
//    orphan's links to the canonical row, delete the orphan; enrich_failures CASCADE);
//  - the bid is new → SET untappd_id on the orphan's own row and pin its links.
// Idempotent. The pin (reviewed_by_user = 1) is what the ingest guard honours.
export function pinMatch(db: DB, beerId: number, untappdId: number, at: string): PinResult {
  const beer = db
    .prepare('SELECT id, untappd_id FROM beers WHERE id = ?')
    .get(beerId) as { id: number; untappd_id: number | null } | undefined;
  if (!beer) return { kind: 'noop', reason: `beer ${beerId} not found` };

  const canonical = db
    .prepare('SELECT id FROM beers WHERE untappd_id = ?')
    .get(untappdId) as { id: number } | undefined;

  return db.transaction((): PinResult => {
    if (canonical && canonical.id !== beerId) {
      const info = db
        .prepare('UPDATE match_links SET untappd_beer_id = ?, reviewed_by_user = 1 WHERE untappd_beer_id = ?')
        .run(canonical.id, beerId);
      db.prepare('DELETE FROM beers WHERE id = ?').run(beerId); // enrich_failures CASCADE-drop
      bumpCatalogVersion();
      return { kind: 'merged', canonicalId: canonical.id, redirected: info.changes as number };
    }
    // New bid (or already this bid) → set on the orphan's own row and pin its links.
    db.prepare('UPDATE beers SET untappd_id = ?, untappd_lookup_at = ? WHERE id = ?')
      .run(untappdId, at, beerId);
    db.prepare('UPDATE match_links SET reviewed_by_user = 1 WHERE untappd_beer_id = ?').run(beerId);
    db.prepare('DELETE FROM enrich_failures WHERE beer_id = ?').run(beerId);
    bumpCatalogVersion();
    return { kind: 'set', beerId };
  })();
}

export interface PinRow {
  ontap_ref: string;
  beer_id: number;
  brewery: string;
  name: string;
  untappd_id: number | null;
}

// Undo a pin by its ontap_ref (reliable for merged pins whose orphan row is gone).
export function unpinByRef(db: DB, ontapRef: string): number {
  return db
    .prepare('UPDATE match_links SET reviewed_by_user = 0 WHERE ontap_ref = ? AND reviewed_by_user = 1')
    .run(ontapRef).changes as number;
}

// Undo a pin by the beer it points at (natural for same-row pins whose orphan survives).
export function unpinByBeer(db: DB, beerId: number): number {
  return db
    .prepare('UPDATE match_links SET reviewed_by_user = 0 WHERE untappd_beer_id = ? AND reviewed_by_user = 1')
    .run(beerId).changes as number;
}

export function listPins(db: DB): PinRow[] {
  return db
    .prepare(
      `SELECT ml.ontap_ref AS ontap_ref, ml.untappd_beer_id AS beer_id,
              b.brewery AS brewery, b.name AS name, b.untappd_id AS untappd_id
         FROM match_links ml
         JOIN beers b ON b.id = ml.untappd_beer_id
        WHERE ml.reviewed_by_user = 1
        ORDER BY ml.ontap_ref`,
    )
    .all() as PinRow[];
}
