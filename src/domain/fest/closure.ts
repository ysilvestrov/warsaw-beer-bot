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

/** queue id → member telegram id → the earliest closing check-in id, or null. */
export function closeQueue(items: ClosureItem[], memberIds: number[], checkins: ClosureCheckin[]): Map<number, Map<number, string | null>> {
  const out = new Map<number, Map<number, string | null>>();
  for (const item of items) {
    const from = Date.parse(item.addedAt) - CLOSE_SLACK_MS;
    const byMember = new Map<number, string | null>();
    for (const m of memberIds) {
      const hits = checkins
        .filter((c) => c.telegramId === m && c.beerId === item.beerId && Date.parse(c.checkinAt) >= from)
        .sort((a, b) => Date.parse(a.checkinAt) - Date.parse(b.checkinAt));
      byMember.set(m, hits.length > 0 ? hits[0].checkinId : null);
    }
    out.set(item.id, byMember);
  }
  return out;
}
