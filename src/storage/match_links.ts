import type { DB } from './db';

export interface MatchRow {
  id: number;
  ontap_ref: string;
  brewery_ref: string;        // #632: точний текст броварні крана; '' коли в крана її немає
  untappd_beer_id: number | null;
  confidence: number;
  reviewed_by_user: number;
  merged_at: string | null;   // #366: non-null ⇒ this link was established by a merge
}

// #632: ключ лінку крана — пара точного тексту броварні крана й назви крана. Броварня крана буває NULL (у `taps`,
// ніколи не ''), і такий кран — окрема пара з порожнім текстом. Єдине місце, де NULL зводиться до ''.
export function tapBreweryKey(breweryRef: string | null | undefined): string {
  return breweryRef ?? '';
}

// #366: this is the matcher's write path (both call sites live in refresh-ontap), so it also
// clears merged_at. Invariant: a link written by the matcher is never merge-derived, which is
// what keeps the matcher authoritative over a remembered merge.
// #632: лише для своєї пари — кран іншої броварні з тією самою назвою цей запис не бачить.
export function upsertMatch(
  db: DB, breweryRef: string | null, ontapRef: string, beerId: number | null, confidence: number,
): void {
  db.prepare(
    `INSERT INTO match_links (ontap_ref, brewery_ref, untappd_beer_id, confidence, reviewed_by_user)
       VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(ontap_ref, brewery_ref) DO UPDATE SET
       untappd_beer_id = excluded.untappd_beer_id,
       confidence = excluded.confidence,
       merged_at = NULL`,
  ).run(ontapRef, tapBreweryKey(breweryRef), beerId, confidence);
}

export function getMatch(db: DB, breweryRef: string | null, ontapRef: string): MatchRow | null {
  return (db.prepare('SELECT * FROM match_links WHERE ontap_ref = ? AND brewery_ref = ?')
    .get(ontapRef, tapBreweryKey(breweryRef)) as MatchRow | undefined) ?? null;
}

export function listUnreviewedBelow(db: DB, threshold: number): MatchRow[] {
  return db.prepare(
    'SELECT * FROM match_links WHERE confidence < ? AND reviewed_by_user = 0 ORDER BY confidence',
  ).all(threshold) as MatchRow[];
}

export function markReviewed(db: DB, id: number, beerId: number | null): void {
  db.prepare(
    'UPDATE match_links SET untappd_beer_id = ?, confidence = 1.0, reviewed_by_user = 1 WHERE id = ?',
  ).run(beerId, id);
}
