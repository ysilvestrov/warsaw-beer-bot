import type { DB } from './db';

export function sentFor(db: DB, teamId: number, sessionNo: number): Set<number> {
  const rows = db.prepare('SELECT beer_id FROM fest_alerts_sent WHERE team_id = ? AND session_no = ?')
    .all(teamId, sessionNo) as { beer_id: number }[];
  return new Set(rows.map((r) => r.beer_id));
}

export function recordSent(
  db: DB,
  rows: { teamId: number; sessionNo: number; beerId: number; checkinId: number }[],
  sentAt: string,
): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO fest_alerts_sent (team_id, session_no, beer_id, checkin_id, sent_at) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (const r of rows) insert.run(r.teamId, r.sessionNo, r.beerId, r.checkinId, sentAt);
  })();
}
