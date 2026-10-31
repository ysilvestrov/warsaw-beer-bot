import { parseCheckinFeedPage } from '../untappd/checkin-feed';
import { checkPage, coverageSpan } from './guards';
import { EMPTY_PAGE, feedPageOf } from './scenarios';

const page = (ids: number[]) => parseCheckinFeedPage(feedPageOf(ids));
const empty = parseCheckinFeedPage(EMPTY_PAGE);

describe('checkPage', () => {
  it.each(['5e2', ' 580 ', '0x244', '0', '-3', ''])('refuses cursor %j as cursor_format', (maxId) => {
    expect(checkPage(page([600]), maxId, null)).toEqual({ kind: 'refuse', status: 400, code: 'bad_cursor', reason: 'cursor_format' });
  });

  it('checks the cursor format before looking at an empty page', () => {
    expect(checkPage(empty, 'x', 580)).toEqual({ kind: 'refuse', status: 400, code: 'bad_cursor', reason: 'cursor_format' });
  });

  it('refuses an empty page above the oldest known check-in as no_session', () => {
    expect(checkPage(empty, '900', 580)).toEqual({ kind: 'refuse', status: 422, code: 'no_session', reason: 'empty_above_known' });
  });

  it.each([
    ['at the oldest known', '580', 580],
    ['below the oldest known', '100', 580],
    ['with no history', '900', null],
    ['on the profile page', null, 580],
  ])('accepts an empty page %s as empty', (_case, maxId, oldestKnown) => {
    expect(checkPage(empty, maxId, oldestKnown)).toEqual({ kind: 'empty' });
  });

  it('refuses a page whose oldest id is above the cursor', () => {
    expect(checkPage(page([700, 650]), '580', null)).toEqual({ kind: 'refuse', status: 400, code: 'bad_cursor', reason: 'oldest_above_cursor' });
  });

  it('refuses a fragment that contains the cursor check-in', () => {
    expect(checkPage(page([580, 570]), '580', null)).toEqual({ kind: 'refuse', status: 400, code: 'bad_cursor', reason: 'page_contains_cursor' });
  });

  it('#854: accepts a fragment with a backdated id above the cursor', () => {
    expect(checkPage(page([590, 560]), '580', null)).toEqual({ kind: 'accept', cursor: 580, ids: [590, 560], oldest: 560, newest: 590 });
  });

  it('accepts the profile page with no cursor', () => {
    expect(checkPage(page([600, 590]), null, null)).toEqual({ kind: 'accept', cursor: null, ids: [600, 590], oldest: 590, newest: 600 });
  });
});

describe('coverageSpan', () => {
  it('is bounded above by the request cursor', () => {
    expect(coverageSpan({ cursor: 580, oldest: 560, newest: 590 })).toEqual([560, 580]);
  });

  it('is bounded above by the newest id on the profile page', () => {
    expect(coverageSpan({ cursor: null, oldest: 590, newest: 600 })).toEqual([590, 600]);
  });
});
