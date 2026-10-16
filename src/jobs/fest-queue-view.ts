import type { DB } from '../storage/db';
import { members } from '../storage/fest_teams';
import { glassMarks, memberBeerCheckins, queueFor } from '../storage/fest_queue';
import { festSessions } from '../storage/fests';
import { presenceEvents } from '../storage/fest_presence';
import { CLOSE_SLACK_MS, closeQueue } from '../domain/fest/closure';
import { expectedOn, presenceIntervals, TABLE_MS } from '../domain/fest/presence';

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
  /**
   * Per member the glass waits for (presence, spec 2026-10-15-fest-queue-reality-design.md §PR 2), in
   * team order: the closing check-in id (✅), their own mark (☑️), or neither (⏳).
   */
  closedBy: { telegramId: number; initials: string; checkinId: string | null; marked: boolean }[];
}

/** Someone the glass waits for has not closed it. A glass that waits for nobody is not open. */
export const isOpen = (item: QueueItemView): boolean => item.closedBy.some((c) => c.checkinId === null && !c.marked);

/** On the table: taken within the last TABLE_MS (the /fest queue window and the duplicate window). */
export const onTable = (item: QueueItemView, now: Date): boolean => Date.parse(item.addedAt) >= now.getTime() - TABLE_MS;

/** The number of an open glass of this beer still on the table at `at`, or null: «Взяв» does not take it twice. */
export function openGlassOf(view: QueueView, beerId: number, at: Date): number | null {
  return view.items.find((i) => i.beerId === beerId && onTable(i, at) && isOpen(i))?.glassNo ?? null;
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
  // Presence that began before the earliest glass still counts: a day starts at most a day earlier.
  const sessions = festSessions(db, p.festId);
  const intervals = presenceIntervals(
    presenceEvents(db, { festId: p.festId, teamId: p.teamId, sinceIso: new Date(Date.parse(since) - 24 * 60 * 60 * 1000).toISOString() }),
    sessions,
  );
  const marks = glassMarks(db, p.teamId);
  const checkins = memberBeerCheckins(db, {
    members: team.map((m) => ({ telegramId: m.telegram_id, untappdUsername: m.untappd_username })),
    beerIds: [...new Set(rows.map((r) => r.beer_id))],
    sinceIso: since,
  });
  const closure = closeQueue(rows.map((r) => ({
    id: r.id, beerId: r.beer_id, addedAt: r.added_at,
    expected: expectedOn(intervals, r.added_at),
    marked: marks.filter((k) => k.queueId === r.id).map((k) => k.telegramId),
  })), team.map((m) => m.telegram_id), checkins);
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
        closedBy: team.filter((m) => closed.has(m.telegram_id)).map((m) => {
          const c = closed.get(m.telegram_id)!;
          return { telegramId: m.telegram_id, initials: m.initials, checkinId: c && 'checkinId' in c ? c.checkinId : null, marked: c !== null && 'marked' in c };
        }),
      };
    }),
  };
}
