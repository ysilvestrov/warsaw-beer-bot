// Paging an Untappd feed through the MCP with a cursor (spec §4.5). With minId Untappd ignores
// `limit` and returns the newest MCP_PAGE_CAP records, leaving a gap down to the cursor (probe
// 2026-09-30), so a full page means "there may be more below": page back with maxId, keeping minId.
// A page with fewer records reaches the cursor. After MCP_MAX_PAGES full pages the rest is a hole:
// the cursor still moves to the newest record seen, or every later tick would stop at the same hole.

export const MCP_PAGE_CAP = 25;
export const MCP_MAX_PAGES = 4;

export type PageStep = 'more' | 'done' | 'hole';

/**
 * After a page: `count` is what Untappd sent on it, `pageNo` is 1-based. Without a cursor the first
 * page is all there is — history before the bot started is not paged back.
 */
export function pageStep(p: { cursor: number | null; pageNo: number; count: number }): PageStep {
  if (p.cursor === null || p.count < MCP_PAGE_CAP) return 'done';
  return p.pageNo >= MCP_MAX_PAGES ? 'hole' : 'more';
}

/** The newest id seen, or the old cursor when nothing new came. */
export function nextCursor(cursor: number | null, ids: number[]): number | null {
  return ids.reduce<number | null>((max, id) => (max === null || id > max ? id : max), cursor);
}

/**
 * After a page of a venue feed read down from the head with maxId (spec
 * 2026-10-02-wfp-mcp-venue-eye-design.md §3.1). With a cursor (the newest check-in this eye stored
 * at the venue) the read stops once a page reaches it; without one — the first read of a window —
 * it stops once a page reaches back to `floorAt` (session start − 60 min). A short page is the
 * venue's bottom either way.
 */
export function venuePageStep(p: { cursor: number | null; floorAt: string; pageNo: number; ids: number[]; oldestAt: string | null }): PageStep {
  if (p.ids.length < MCP_PAGE_CAP) return 'done';
  if (p.cursor !== null ? Math.min(...p.ids) <= p.cursor : p.oldestAt !== null && Date.parse(p.oldestAt) <= Date.parse(p.floorAt)) return 'done';
  return p.pageNo >= MCP_MAX_PAGES ? 'hole' : 'more';
}
