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

/**
 * Each member's presence: a start (explicit or a member's own action) opens an interval when none is
 * open, an end closes it. One still open ends with the session it began in — the first session ending
 * at or after its start — or at its start when no session is left: /fest end forgotten stops at the
 * session's end, never runs into the next day.
 */
export function presenceIntervals(events: PresenceEvent[], sessions: FestSession[]): Map<number, Interval[]> {
  const ends = sessions.map((s) => Date.parse(s.end_at)).sort((a, b) => a - b);
  const sessionEnd = (t: number): number => ends.find((e) => e >= t) ?? t;
  const out = new Map<number, Interval[]>();
  const open = new Map<number, number>();
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || Number(a.kind === 'end') - Number(b.kind === 'end'));
  const close = (member: number, from: number, to: number) => {
    out.set(member, [...(out.get(member) ?? []), { from, to }]);
    open.delete(member);
  };
  for (const e of ordered) {
    const t = Date.parse(e.at);
    const from = open.get(e.telegramId);
    // A start after the session it opened in has ended belongs to a new day.
    if (from !== undefined && t > sessionEnd(from)) close(e.telegramId, from, sessionEnd(from));
    const still = open.get(e.telegramId);
    if (e.kind === 'start') {
      if (still === undefined) open.set(e.telegramId, t);
    } else if (still !== undefined) {
      close(e.telegramId, still, t);
    }
  }
  for (const [member, from] of open) close(member, from, sessionEnd(from));
  return out;
}

/** Members expected on a glass taken at `addedAt`: their presence touches [addedAt, addedAt + TABLE_MS]. */
export function expectedOn(intervals: Map<number, Interval[]>, addedAt: string): number[] {
  const from = Date.parse(addedAt);
  const to = from + TABLE_MS;
  return [...intervals].filter(([, list]) => list.some((i) => i.from <= to && i.to >= from)).map(([member]) => member);
}
