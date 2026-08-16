import { nextDelayHours, isEligible, BACKOFF_HOURS, RECURRING_CLASSES } from './lookup-backoff';

describe('BACKOFF_HOURS', () => {
  test('exactly the trimmed schedule (4 attempts, then dormant)', () => {
    expect(BACKOFF_HOURS).toEqual([0, 72, 168, 728]);
  });
});

describe('nextDelayHours', () => {
  test.each([
    [0, 0],
    [1, 72],
    [2, 168],
    [3, 728],
    [4, 728],
    [10, 728],
    [100, 728],
  ])('count=%i returns %i', (count, expected) => {
    expect(nextDelayHours(count)).toBe(expected);
  });
});

describe('isEligible', () => {
  const now = new Date('2026-05-26T12:00:00Z');

  test('returns true when lookupAt is null and attempts remain', () => {
    expect(isEligible(now, null, 0)).toBe(true);
    expect(isEligible(now, null, 3)).toBe(true);
  });

  test('terminal: count >= schedule length is never eligible, even if never tried', () => {
    // After BACKOFF_HOURS.length (4) failed attempts the orphan goes dormant
    // forever — no further Untappd lookups regardless of lookupAt.
    expect(isEligible(now, null, 4)).toBe(false);
    expect(isEligible(now, '2000-01-01T00:00:00Z', 4)).toBe(false);
    expect(isEligible(now, '2000-01-01T00:00:00Z', 10)).toBe(false);
  });

  test('count=0 with any lookupAt is eligible (delay = 0h)', () => {
    expect(isEligible(now, '2026-05-26T11:59:00Z', 0)).toBe(true);
  });

  test('count=1: not eligible if last lookup was 71h ago', () => {
    const tried = new Date('2026-05-23T13:00:00Z').toISOString();
    expect(isEligible(now, tried, 1)).toBe(false);
  });

  test('count=1: eligible if last lookup was 73h ago', () => {
    const tried = new Date('2026-05-23T11:00:00Z').toISOString();
    expect(isEligible(now, tried, 1)).toBe(true);
  });

  test('count=3: eligible exactly at the 728h boundary', () => {
    const tried = new Date(now.getTime() - 728 * 3600_000).toISOString();
    expect(isEligible(now, tried, 3)).toBe(true);
  });

  test('count=3: not eligible an hour before the 728h boundary', () => {
    const tried = new Date(now.getTime() - 727 * 3600_000).toISOString();
    expect(isEligible(now, tried, 3)).toBe(false);
  });
});

// #421. The schedule is a bet that TIME changes the answer, and that bet is true for
// exactly one verdict: `not_on_untappd` says the beer is not in Untappd's catalogue YET,
// and the catalogue grows. Letting such a row exhaust the schedule makes a verdict that is
// reversible by construction permanently unreversible — which is the contradiction #377
// left open when it justified the class with "Untappd grows".
describe('isEligible: recurring tail', () => {
  const last = '2026-06-01T00:00:00Z';

  // Red if the `&& !recurring` guard is removed from the terminal check.
  test('re-offers an exhausted row once the last delay has passed', () => {
    expect(isEligible(new Date('2026-07-05T00:00:00Z'), last, 6, true)).toBe(true);
  });

  // Red if `recurring` skips the delay instead of repeating it: the tail is a slower
  // schedule, not the absence of one. 728h is ~30 days; two weeks in is too early.
  test('still waits out the last delay before re-offering', () => {
    expect(isEligible(new Date('2026-06-15T00:00:00Z'), last, 6, false)).toBe(false);
    expect(isEligible(new Date('2026-06-15T00:00:00Z'), last, 6, true)).toBe(false);
  });

  // Red if `recurring` is passed unconditionally. `unidentifiable` and the pre-v23 rows
  // with no issue have neither a fix owner nor a growing external catalogue to wait for,
  // so a repeating retry would be exactly the timer-with-no-bet this issue exists to remove.
  test('keeps the terminal schedule when not recurring', () => {
    expect(isEligible(new Date('2027-01-01T00:00:00Z'), last, 4)).toBe(false);
  });

  // The classes list is the seam between the pure schedule and the storage layer that
  // reads review_class. Red if a second class is added without a design decision.
  test('RECURRING_CLASSES names not_on_untappd and nothing else', () => {
    expect(RECURRING_CLASSES).toEqual(['not_on_untappd']);
  });
});
