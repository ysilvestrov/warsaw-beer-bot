import { expect, test } from 'vitest';
import { previousDate, warsawDateAndHour } from './warsaw-time';

test('summer (CEST = UTC+2): date and hour extraction', () => {
  expect(warsawDateAndHour(new Date('2026-07-05T05:30:00Z')))
    .toEqual({ date: '2026-07-05', hour: 7 });
});

test('winter (CET = UTC+1): hour extraction', () => {
  expect(warsawDateAndHour(new Date('2026-01-05T08:30:00Z')).hour).toBe(9);
});

test('UTC date rolls forward across Warsaw midnight', () => {
  expect(warsawDateAndHour(new Date('2026-07-04T22:30:00Z')))
    .toEqual({ date: '2026-07-05', hour: 0 });
});

test('previousDate: normal day', () => {
  expect(previousDate('2026-06-05')).toBe('2026-06-04');
});
test('previousDate: month boundary', () => {
  expect(previousDate('2026-07-01')).toBe('2026-06-30');
});
test('previousDate: year boundary', () => {
  expect(previousDate('2026-01-01')).toBe('2025-12-31');
});
test('previousDate: non-leap February', () => {
  expect(previousDate('2026-03-01')).toBe('2026-02-28');
});
test('previousDate: leap February', () => {
  expect(previousDate('2028-03-01')).toBe('2028-02-29');
});
