import { expect, test } from 'vitest';
import { warsawDateAndHour } from './warsaw-time';

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
