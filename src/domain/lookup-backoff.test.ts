import { nextDelayHours, isEligible, BACKOFF_HOURS } from './lookup-backoff';

describe('BACKOFF_HOURS', () => {
  test('exactly the schedule from the spec', () => {
    expect(BACKOFF_HOURS).toEqual([0, 24, 72, 168, 336, 720]);
  });
});

describe('nextDelayHours', () => {
  test.each([
    [0, 0],
    [1, 24],
    [2, 72],
    [3, 168],
    [4, 336],
    [5, 720],
    [6, 720],
    [10, 720],
    [100, 720],
  ])('count=%i returns %i', (count, expected) => {
    expect(nextDelayHours(count)).toBe(expected);
  });
});

describe('isEligible', () => {
  const now = new Date('2026-05-26T12:00:00Z');

  test('returns true when lookupAt is null (never tried)', () => {
    expect(isEligible(now, null, 0)).toBe(true);
    expect(isEligible(now, null, 3)).toBe(true);
  });

  test('count=0 with any lookupAt is eligible (delay = 0h)', () => {
    expect(isEligible(now, '2026-05-26T11:59:00Z', 0)).toBe(true);
  });

  test('count=1: not eligible if last lookup was 23h ago', () => {
    const tried = new Date('2026-05-25T13:00:00Z').toISOString();
    expect(isEligible(now, tried, 1)).toBe(false);
  });

  test('count=1: eligible if last lookup was 25h ago', () => {
    const tried = new Date('2026-05-25T11:00:00Z').toISOString();
    expect(isEligible(now, tried, 1)).toBe(true);
  });

  test('count=5: eligible exactly at 30d boundary', () => {
    const tried = new Date('2026-04-26T12:00:00Z').toISOString();
    expect(isEligible(now, tried, 5)).toBe(true);
  });

  test('count=5: not eligible at 29d ago', () => {
    const tried = new Date('2026-04-27T12:00:00Z').toISOString();
    expect(isEligible(now, tried, 5)).toBe(false);
  });
});
