import type { DB } from '../storage/db';
import { members } from '../storage/fest_teams';
import { memberBeerCheckins, queueFor } from '../storage/fest_queue';
import { CLOSE_SLACK_MS, closeQueue } from '../domain/fest/closure';

export interface QueueItemView {
  id: number;
  glassNo: number;
  beerId: number;
  name: string;
  brewery: string;
  bid: number | null;
  /** A menu section of this beer in the team's fest, if it is on the menu. */
  section: string | null;
  takenBy: string;
  addedAt: string;
  /** Per member, in team order: the closing check-in id, or null (⏳). */
  closedBy: { initials: string; checkinId: string | null }[];
}

export interface QueueView {
  items: QueueItemView[];
}

// The queue reads beers through fest_queue.beer_id, never through Targets: a beer stops being a
// Target the moment one member drinks it, and it must stay in the queue for the others.
export function buildQueueView(db: DB, p: { festId: number; teamId: number }): QueueView {
  const rows = queueFor(db, p.teamId);
  if (rows.length === 0) return { items: [] };
  const team = members(db, p.teamId);
  const initials = new Map(team.map((m) => [m.telegram_id, m.initials]));
  const beer = db.prepare(
    `SELECT b.name, b.brewery, b.untappd_id AS bid,
            (SELECT section FROM fest_menu m WHERE m.fest_id = ? AND m.beer_id = b.id ORDER BY section LIMIT 1) AS section
       FROM beers b WHERE b.id = ?`,
  );
  const since = new Date(Math.min(...rows.map((r) => Date.parse(r.added_at))) - CLOSE_SLACK_MS).toISOString();
  const checkins = memberBeerCheckins(db, {
    members: team.map((m) => ({ telegramId: m.telegram_id, untappdUsername: m.untappd_username })),
    beerIds: [...new Set(rows.map((r) => r.beer_id))],
    sinceIso: since,
  });
  const closure = closeQueue(rows.map((r) => ({ id: r.id, beerId: r.beer_id, addedAt: r.added_at })), team.map((m) => m.telegram_id), checkins);
  return {
    items: rows.map((r) => {
      const b = beer.get(p.festId, r.beer_id) as { name: string; brewery: string; bid: number | null; section: string | null } | undefined;
      const closed = closure.get(r.id)!;
      return {
        id: r.id,
        glassNo: r.glass_no,
        beerId: r.beer_id,
        name: b?.name ?? `#${r.beer_id}`,
        brewery: b?.brewery ?? '',
        bid: b?.bid ?? null,
        section: b?.section ?? null,
        takenBy: initials.get(r.added_by) ?? '?',
        addedAt: r.added_at,
        closedBy: team.map((m) => ({ initials: m.initials, checkinId: closed.get(m.telegram_id) ?? null })),
      };
    }),
  };
}
