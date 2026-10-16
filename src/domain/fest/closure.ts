// "Випито" (spec §6.4): a queue item is closed for a member by that member's check-in of the same
// beer made no earlier than ten minutes before the item was queued — people check in while the
// glass is being carried over. It is never stored: it is recomputed from check-ins, and the
// check-in that proves it is shown. No check-in means "not yet" (⏳), never "did not drink".

export const CLOSE_SLACK_MS = 10 * 60 * 1000;

export interface ClosureItem {
  id: number;
  beerId: number;
  addedAt: string;
  /** Members the glass waits for (presence, spec 2026-10-15-fest-queue-reality-design.md §PR 2). */
  expected: number[];
  /** Members who marked it done themselves (☑️). */
  marked: number[];
}

export interface ClosureCheckin {
  telegramId: number;
  beerId: number;
  checkinId: string;
  checkinAt: string;
}

/** How a glass is closed for a member: by a check-in, by their own mark, or not yet. */
export type Closure = { checkinId: string } | { marked: true } | null;

/**
 * queue id → expected member → how it is closed. One check-in proves one glass: for each member,
 * glasses are matched in queue order to the earliest check-in not yet used, so two glasses of the
 * same beer need two check-ins to both show ✅. A glass the member marked takes no check-in (it goes
 * to their next glass of that beer); a glass that does not wait for the member takes none either.
 */
export function closeQueue(items: ClosureItem[], memberIds: number[], checkins: ClosureCheckin[]): Map<number, Map<number, Closure>> {
  const out = new Map<number, Map<number, Closure>>(items.map((item) => [item.id, new Map<number, Closure>()]));
  const ordered = [...items].sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt) || a.id - b.id);
  for (const m of memberIds) {
    const own = checkins
      .filter((c) => c.telegramId === m)
      .sort((a, b) => Date.parse(a.checkinAt) - Date.parse(b.checkinAt));
    // By id, not by object: the same Untappd check-in can arrive from the member's history and
    // from an authored venue row, and it still proves only one glass.
    const used = new Set<string>();
    for (const item of ordered) {
      if (!item.expected.includes(m)) continue;
      if (item.marked.includes(m)) {
        out.get(item.id)!.set(m, { marked: true });
        continue;
      }
      const from = Date.parse(item.addedAt) - CLOSE_SLACK_MS;
      const hit = own.find((c) => !used.has(c.checkinId) && c.beerId === item.beerId && Date.parse(c.checkinAt) >= from);
      if (hit) used.add(hit.checkinId);
      out.get(item.id)!.set(m, hit ? { checkinId: hit.checkinId } : null);
    }
  }
  return out;
}
