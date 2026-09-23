import type { DB } from './db';
import { cardAbv, cardText } from '../domain/card-text';

export interface ActiveLegacyDisposition {
  id: number;
  beerId: number;
  issueNumber: number;
  cardBrewery: string;
  cardName: string;
  cardAbv: number | null;
  breweryText: string;
  nameText: string;
  abvKey: string;
  failureSourceUrl: string;
  reason: string;
  evidenceUrl: string;
  operator: string;
  inactiveAt: string;
}

export interface LegacyDispositionInsert extends Omit<ActiveLegacyDisposition, 'id'> {}

export interface LegacyReopening {
  reopenedAt: string;
  reopeningReason: string;
  reopeningEvidenceUrl: string;
  reopeningOperator: string;
}

interface DispositionRow {
  id: number;
  beer_id: number;
  issue_number: number;
  card_brewery: string;
  card_name: string;
  card_abv: number | null;
  brewery_text: string;
  name_text: string;
  abv_key: string;
  failure_source_url: string;
  reason: string;
  evidence_url: string;
  operator: string;
  inactive_at: string;
}

function active(row: DispositionRow | undefined): ActiveLegacyDisposition | null {
  if (!row) return null;
  return {
    id: row.id, beerId: row.beer_id, issueNumber: row.issue_number,
    cardBrewery: row.card_brewery, cardName: row.card_name, cardAbv: row.card_abv,
    breweryText: row.brewery_text, nameText: row.name_text, abvKey: row.abv_key,
    failureSourceUrl: row.failure_source_url, reason: row.reason,
    evidenceUrl: row.evidence_url, operator: row.operator, inactiveAt: row.inactive_at,
  };
}

export function findActiveDispositionForBeer(db: DB, beerId: number): ActiveLegacyDisposition | null {
  return active(db.prepare(`SELECT * FROM legacy_orphan_dispositions
    WHERE beer_id = ? AND reopened_at IS NULL`).get(beerId) as DispositionRow | undefined);
}

export function findActiveDispositionForCard(
  db: DB, brewery: string, name: string, abv: number | null,
): ActiveLegacyDisposition | null {
  return active(db.prepare(`SELECT * FROM legacy_orphan_dispositions
    WHERE brewery_text = ? AND name_text = ? AND abv_key = ? AND reopened_at IS NULL`)
    .get(cardText(brewery), cardText(name), cardAbv(abv)) as DispositionRow | undefined);
}

export function insertLegacyDisposition(db: DB, row: LegacyDispositionInsert): number {
  const result = db.prepare(`INSERT INTO legacy_orphan_dispositions (
    beer_id, issue_number, card_brewery, card_name, card_abv, brewery_text, name_text,
    abv_key, failure_source_url, reason, evidence_url, operator, inactive_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.beerId, row.issueNumber, row.cardBrewery, row.cardName, row.cardAbv,
    row.breweryText, row.nameText, row.abvKey, row.failureSourceUrl,
    row.reason, row.evidenceUrl, row.operator, row.inactiveAt,
  );
  return Number(result.lastInsertRowid);
}

export function closeLegacyDisposition(db: DB, id: number, reopening: LegacyReopening): boolean {
  return db.prepare(`UPDATE legacy_orphan_dispositions SET
    reopened_at = ?, reopening_reason = ?, reopening_evidence_url = ?, reopening_operator = ?
    WHERE id = ? AND reopened_at IS NULL`).run(
    reopening.reopenedAt, reopening.reopeningReason,
    reopening.reopeningEvidenceUrl, reopening.reopeningOperator, id,
  ).changes === 1;
}
