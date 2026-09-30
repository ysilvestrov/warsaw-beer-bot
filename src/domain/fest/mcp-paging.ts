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
