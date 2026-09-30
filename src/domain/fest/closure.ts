// "Випито" (spec §6.4): a queue item is closed for a member by that member's check-in of the same
// beer made no earlier than ten minutes before the item was queued — people check in while the
// glass is being carried over. It is never stored: it is recomputed from check-ins, and the
// check-in that proves it is shown. No check-in means "not yet" (⏳), never "did not drink".

export const CLOSE_SLACK_MS = 10 * 60 * 1000;

export interface ClosureItem {
  id: number;
  beerId: number;
  addedAt: string;
}

export interface ClosureCheckin {
  telegramId: number;
  beerId: number;
  checkinId: string;
  checkinAt: string;
}

/**
 * queue id → member telegram id → the closing check-in id, or null. One check-in proves one glass:
 * for each member, glasses are matched in queue order to the earliest check-in not yet used, so
 * two glasses of the same beer need two check-ins to both show ✅.
 */
export function closeQueue(items: ClosureItem[], memberIds: number[], checkins: ClosureCheckin[]): Map<number, Map<number, string | null>> {
  const out = new Map<number, Map<number, string | null>>(items.map((item) => [item.id, new Map<number, string | null>()]));
  const ordered = [...items].sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt) || a.id - b.id);
  for (const m of memberIds) {
    const own = checkins
      .filter((c) => c.telegramId === m)
      .sort((a, b) => Date.parse(a.checkinAt) - Date.parse(b.checkinAt));
    // By id, not by object: the same Untappd check-in can arrive from the member's history and
    // from an authored venue row, and it still proves only one glass.
    const used = new Set<string>();
    for (const item of ordered) {
      const from = Date.parse(item.addedAt) - CLOSE_SLACK_MS;
      const hit = own.find((c) => !used.has(c.checkinId) && c.beerId === item.beerId && Date.parse(c.checkinAt) >= from);
      if (hit) used.add(hit.checkinId);
      out.get(item.id)!.set(m, hit ? hit.checkinId : null);
    }
  }
  return out;
}
