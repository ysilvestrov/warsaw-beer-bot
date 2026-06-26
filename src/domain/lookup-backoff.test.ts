import { nextDelayHours, isEligible, BACKOFF_HOURS } from './lookup-backoff';

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
