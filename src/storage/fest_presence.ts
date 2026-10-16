import type { DB } from './db';

// Presence at the table (spec 2026-10-15-fest-queue-reality-design.md §PR 2): who is with the team,
// so a glass waits only for them. Explicit /fest start and /fest end are stored; an implicit start —
// a member's own «Взяв» or authored check-in at a venue of the fest — is read from where it already is.

export interface PresenceEvent {
  telegramId: number;
  kind: 'start' | 'end';
  /** An explicit /fest start or /fest end, or an implicit start from an own «Взяв» or venue check-in. */
  source: 'explicit' | 'take' | 'checkin';
  /** ISO-8601 UTC with 'Z'. */
  at: string;
}

export function addPresence(db: DB, p: { teamId: number; telegramId: number; kind: 'start' | 'end'; at: string }): void {
  db.prepare('INSERT INTO fest_presence (team_id, telegram_id, kind, at) VALUES (?, ?, ?, ?)')
    .run(p.teamId, p.telegramId, p.kind, new Date(p.at).toISOString());
}

/**
 * The team's presence events since `sinceIso`, oldest first: explicit ones and an implicit start for
 * each own «Взяв» and each own authored venue check-in at a venue of the fest. Venue rows carry the
 * author as shown on the site, so names are compared without case.
 */
export function presenceEvents(db: DB, p: { festId: number; teamId: number; sinceIso: string }): PresenceEvent[] {
  const rows = db.prepare(
    `SELECT telegram_id AS telegramId, kind, 'explicit' AS source, at FROM fest_presence WHERE team_id = ? AND at >= ?
     UNION ALL
     SELECT added_by, 'start', 'take', added_at FROM fest_queue WHERE team_id = ? AND added_at >= ?
     UNION ALL
     SELECT m.telegram_id, 'start', 'checkin', v.checkin_at
       FROM fest_team_members m
       JOIN user_profiles u ON u.telegram_id = m.telegram_id
       JOIN venue_checkins v ON lower(v.untappd_user) = lower(u.untappd_username)
       JOIN fest_venues fv ON fv.venue_id = v.venue_id AND fv.fest_id = ?
      WHERE m.team_id = ? AND v.checkin_at >= ?`,
  ).all(p.teamId, p.sinceIso, p.teamId, p.sinceIso, p.festId, p.teamId, p.sinceIso) as PresenceEvent[];
  // An explicit event and an implicit start at the same instant: the explicit one comes later, so
  // /fest end pressed at the moment of a check-in still ends the day.
  const rank = (e: PresenceEvent) => (e.kind === 'end' ? 1 : 0);
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || rank(a) - rank(b));
}
