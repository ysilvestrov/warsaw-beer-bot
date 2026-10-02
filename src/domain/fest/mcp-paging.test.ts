import { MCP_MAX_PAGES, MCP_PAGE_CAP, nextCursor, pageStep, venuePageStep } from './mcp-paging';

describe('pageStep', () => {
  it('a page one short of the cap reaches the cursor; a full page asks for more', () => {
    expect([
      pageStep({ cursor: 100, pageNo: 1, count: MCP_PAGE_CAP - 1 }),
      pageStep({ cursor: 100, pageNo: 1, count: MCP_PAGE_CAP }),
    ]).toEqual(['done', 'more']);
  });

  it('a full last allowed page is a hole', () => {
    expect([
      pageStep({ cursor: 100, pageNo: MCP_MAX_PAGES - 1, count: MCP_PAGE_CAP }),
      pageStep({ cursor: 100, pageNo: MCP_MAX_PAGES, count: MCP_PAGE_CAP }),
    ]).toEqual(['more', 'hole']);
  });

  it('without a cursor the first page is all: no paging back into history', () => {
    expect(pageStep({ cursor: null, pageNo: 1, count: MCP_PAGE_CAP })).toBe('done');
  });
});

describe('nextCursor', () => {
  it('moves to the newest id seen; stays put when nothing came; starts from nothing', () => {
    expect([nextCursor(100, [150, 120, 101]), nextCursor(100, []), nextCursor(null, []), nextCursor(null, [7, 9])])
      .toEqual([150, 100, null, 9]);
  });
});

describe('venuePageStep', () => {
  // A full page: ids 1025 down to 1001.
  const full = Array.from({ length: MCP_PAGE_CAP }, (_, i) => 1025 - i);
  const FLOOR = '2026-10-15T13:00:00.000Z';
  const step = (p: Partial<Parameters<typeof venuePageStep>[0]>) =>
    venuePageStep({ cursor: 900, floorAt: FLOOR, pageNo: 1, count: MCP_PAGE_CAP, ids: full, oldestAt: '2026-10-15T14:00:00.000Z', ...p });

  it('a short page (by what Untappd sent) is the bottom of the venue, cursor or not', () => {
    expect([step({ count: MCP_PAGE_CAP - 1 }), step({ count: 0, ids: [] }), step({ cursor: null, count: MCP_PAGE_CAP - 1 })])
      .toEqual(['done', 'done', 'done']);
  });

  it('a full page with an unreadable record is still full: it does not pass for the bottom', () => {
    expect(step({ ids: full.slice(1) })).toBe('more');
  });

  it('a full page with nothing readable cannot be paged below: a hole', () => {
    expect([step({ ids: [], oldestAt: null }), step({ cursor: null, ids: [], oldestAt: null })]).toEqual(['hole', 'hole']);
  });

  it('with a cursor: a full page wholly above it asks for more; a page holding it is done', () => {
    expect([step({ cursor: 1000 }), step({ cursor: 1001 }), step({ cursor: 1010 })])
      .toEqual(['more', 'done', 'done']);
  });

  it('without a cursor: reads down to the floor, inclusive; the cursor rule is not applied', () => {
    expect([
      step({ cursor: null }),
      step({ cursor: null, oldestAt: FLOOR }),
      step({ cursor: null, oldestAt: '2026-10-15T12:59:59.000Z' }),
      step({ cursor: null, oldestAt: null }),
    ]).toEqual(['more', 'done', 'done', 'more']);
  });

  it('the fourth full page short of the stop is a hole, the third still asks for more', () => {
    expect([step({ pageNo: MCP_MAX_PAGES - 1 }), step({ pageNo: MCP_MAX_PAGES }), step({ cursor: null, pageNo: MCP_MAX_PAGES })])
      .toEqual(['more', 'hole', 'hole']);
  });
});
