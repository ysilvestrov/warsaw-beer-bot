import type { DB } from '../storage/db';
import { cardAbv, cardText } from '../domain/card-text';
import { hasCurrentRescueProof } from '../storage/enrich_failures';
import { findActiveDispositionForBeer } from '../storage/legacy-orphan-dispositions';

export interface CloseoutRow {
  beerId: number;
  state: 'rescued' | 'inactive' | 'blocked';
  reason: string;
}

export interface CloseoutReport {
  issueNumber: number;
  rows: CloseoutRow[];
  repairs: { orphanBeerId: number; targetBid: number }[];
  ready: boolean;
}

export function inspectOrphanIssue(db: DB, issueNumber: number): CloseoutReport {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('issue must be a positive integer');
  const linked = db.prepare(`SELECT ef.beer_id, ef.retired_at, ef.unrescued_at,
      b.brewery, b.name, b.abv, b.untappd_id
    FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
    WHERE ef.issue_number = ? ORDER BY ef.beer_id`).all(issueNumber) as {
      beer_id: number; retired_at: string | null; unrescued_at: string | null;
      brewery: string; name: string; abv: number | null; untappd_id: number | null;
    }[];
  const rows: CloseoutRow[] = linked.map((row) => {
    const beerId = row.beer_id;
    const disposition = findActiveDispositionForBeer(db, beerId);
    if (disposition?.issueNumber === issueNumber
      && disposition.breweryText === cardText(row.brewery)
      && disposition.nameText === cardText(row.name)
      && disposition.abvKey === cardAbv(row.abv)
      && row.untappd_id === null && row.retired_at === null && row.unrescued_at === null) {
      return { beerId, state: 'inactive', reason: `active disposition ${disposition.id}` };
    }
    if (hasCurrentRescueProof(db, beerId, issueNumber)) {
      return { beerId, state: 'rescued', reason: 'current positive replay' };
    }
    const reason = row.retired_at !== null ? 'retired without a closeout disposition'
      : row.untappd_id !== null ? 'matched beer still has a failure row'
        : row.unrescued_at !== null ? 'unrescued replay is not a closeout disposition'
          : 'no current positive replay or active disposition';
    return { beerId, state: 'blocked', reason };
  });
  const repairs = db.prepare(`SELECT orphan_beer_id AS orphanBeerId, target_bid AS targetBid
    FROM legacy_card_repairs WHERE issue_number = ? ORDER BY orphan_beer_id`)
    .all(issueNumber) as { orphanBeerId: number; targetBid: number }[];
  return { issueNumber, rows, repairs, ready: rows.every((row) => row.state !== 'blocked') };
}
