import type { FestSession } from '../../storage/fests';
import type { PresenceEvent } from '../../storage/fest_presence';

// Who is at the table (spec 2026-10-15-fest-queue-reality-design.md §PR 2, amendment 16.10): a glass
// waits only for members whose presence touches the 40 minutes after it was taken — someone who came
// ten minutes later still drinks it, someone who left before it did not.

/** How long a glass stays on the table: the /fest queue window, and the window of a duplicate. */
export const TABLE_MS = 40 * 60 * 1000;

export interface Interval {
  from: number;
  to: number;
}

/** A day at the table may begin this long before its session opens: people arrive before the doors. */
export const SESSION_LEAD_MS = 60 * 60 * 1000;

/**
 * Each member's presence. A start opens an interval when none is open, an end closes it. A start
 * belongs to the session it falls in (from SESSION_LEAD_MS before its opening to its end) and an open
 * interval ends with that session — /fest end forgotten never runs into the next day. A start outside
 * every session lasts an instant: an action the evening after does not make anyone present tomorrow.
 * After an explicit end, only an explicit start or an own «Взяв» opens the day again in that session —
 * a check-in on the way out does not undo /fest end.
 */
export function presenceIntervals(events: PresenceEvent[], sessions: FestSession[]): Map<number, Interval[]> {
  const windows = sessions.map((s) => ({ from: Date.parse(s.start_at) - SESSION_LEAD_MS, to: Date.parse(s.end_at) }));
  const sessionEnd = (t: number): number | null => windows.find((w) => w.from <= t && t <= w.to)?.to ?? null;
  const out = new Map<number, Interval[]>();
  const add = (member: number, i: Interval) => out.set(member, [...(out.get(member) ?? []), i]);
  const open = new Map<number, { from: number; until: number }>();
  /** The session end until which an explicit /fest end holds against check-ins. */
  const ended = new Map<number, number>();
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || Number(a.kind === 'end') - Number(b.kind === 'end'));
  for (const e of ordered) {
    const t = Date.parse(e.at);
    const m = e.telegramId;
    const current = open.get(m);
    if (current !== undefined && t > current.until) {
      add(m, { from: current.from, to: current.until });
      open.delete(m);
    }
    const endedUntil = ended.get(m);
    if (endedUntil !== undefined && t > endedUntil) ended.delete(m);
    const still = open.get(m);
    if (e.kind === 'end') {
      if (still !== undefined) {
        add(m, { from: still.from, to: t });
        open.delete(m);
      }
      const until = sessionEnd(t);
      if (e.source === 'explicit' && until !== null) ended.set(m, until);
      continue;
    }
    if (still !== undefined) continue;
    if (e.source === 'checkin' && ended.has(m)) continue;
    const until = sessionEnd(t);
    if (until === null) add(m, { from: t, to: t });
    else open.set(m, { from: t, until });
  }
  for (const [m, i] of open) add(m, { from: i.from, to: i.until });
  return out;
}
/** Members expected on a glass taken at `addedAt`: their presence touches [addedAt, addedAt + TABLE_MS]. */
export function expectedOn(intervals: Map<number, Interval[]>, addedAt: string): number[] {
  const from = Date.parse(addedAt);
  const to = from + TABLE_MS;
  return [...intervals].filter(([, list]) => list.some((i) => i.from <= to && i.to >= from)).map(([member]) => member);
}
