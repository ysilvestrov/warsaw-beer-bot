import { MCP_MAX_PAGES, MCP_PAGE_CAP, nextCursor, pageStep } from './mcp-paging';

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
