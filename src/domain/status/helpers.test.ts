import { gib, groupThousands, median, parseIsoInstant, previousDays, shiftDate, snapshotOn, warsawClock } from './helpers';
import { GREEN_METRICS } from './test-inputs';

const rec = (date: string) => ({ date, metrics: GREEN_METRICS });

test('shiftDate crosses month and year boundaries in both directions', () => {
  expect([shiftDate('2026-10-01', -1), shiftDate('2026-12-31', 1), shiftDate('2026-03-29', 1)])
    .toEqual(['2026-09-30', '2027-01-01', '2026-03-30']);
});

test('snapshotOn finds the exact date or returns null', () => {
  const history = [rec('2026-10-04'), rec('2026-10-05')];
  expect([snapshotOn(history, '2026-10-05')?.date, snapshotOn(history, '2026-10-03')]).toEqual(['2026-10-05', null]);
});

test('previousDays returns the n days before the date, newest first', () => {
  const history = [rec('2026-10-03'), rec('2026-10-05'), rec('2026-10-04')];
  expect(previousDays(history, '2026-10-06', 3)?.map((s) => s.date)).toEqual(['2026-10-05', '2026-10-04', '2026-10-03']);
});

test('previousDays is null when any day in the window is missing', () => {
  const history = [rec('2026-10-03'), rec('2026-10-05')];
  expect(previousDays(history, '2026-10-06', 3)).toBeNull();
});

test('median of odd and even counts', () => {
  expect([median([5, 1, 3]), median([4, 1, 3, 2])]).toEqual([3, 2.5]);
});

test('warsawClock renders Warsaw wall time across the DST change', () => {
  expect([warsawClock('2026-10-06T03:30:10.000Z'), warsawClock('2026-11-02T03:30:10.000Z')]).toEqual(['05:30', '04:30']);
});

test('groupThousands and gib format numbers for the report', () => {
  expect([groupThousands(2078442), groupThousands(999), gib(34_750_201_856)]).toEqual(['2 078 442', '999', '32.36']);
});

test('parseIsoInstant accepts only real instants in toISOString form', () => {
  expect([
    parseIsoInstant('2026-10-06T07:00:00.000Z'),
    parseIsoInstant('2026-10-06T07:00:00Z'),
    parseIsoInstant('2028-02-29T00:00:00.000Z'),
    parseIsoInstant('2026-02-29T00:00:00.000Z'),
    parseIsoInstant('2026-10-06T24:00:00.000Z'),
    parseIsoInstant('0'),
    parseIsoInstant('2026-10-06 07:00:00'),
  ]).toEqual([
    Date.UTC(2026, 9, 6, 7), Date.UTC(2026, 9, 6, 7), Date.UTC(2028, 1, 29),
    Number.NaN, Number.NaN, Number.NaN, Number.NaN,
  ]);
});
