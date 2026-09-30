import { dueMenuRefresh, dueServerPoll } from './schedule';

const at = (iso: string) => new Date(iso);
// WFP22 Thursday session 14:00–22:00Z → polling window 13:30–22:30Z; Friday 11:30–22:30Z.
const WINDOWS = [
  { start_at: '2026-10-15T13:30:00.000Z', end_at: '2026-10-15T22:30:00.000Z' },
  { start_at: '2026-10-16T11:30:00.000Z', end_at: '2026-10-16T22:30:00.000Z' },
];

describe('dueServerPoll', () => {
  it('is due on the first tick of a window', () => {
    expect(dueServerPoll(at('2026-10-15T13:30:00.000Z'), true, null)).toBe(true);
  });

  it('waits 10 minutes between polls: 9:59 no, 10:00 yes', () => {
    expect([
      dueServerPoll(at('2026-10-15T14:09:59.000Z'), true, '2026-10-15T14:00:00.000Z'),
      dueServerPoll(at('2026-10-15T14:10:00.000Z'), true, '2026-10-15T14:00:00.000Z'),
    ]).toEqual([false, true]);
  });

  it('never polls outside a window', () => {
    expect(dueServerPoll(at('2026-10-16T02:00:00.000Z'), false, null)).toBe(false);
  });
});

describe('dueMenuRefresh', () => {
  it('in the run-up reads every 6 hours', () => {
    expect([
      dueMenuRefresh(at('2026-10-09T11:59:00.000Z'), WINDOWS, '2026-10-09T06:00:00.000Z'),
      dueMenuRefresh(at('2026-10-09T12:00:00.000Z'), WINDOWS, '2026-10-09T06:00:00.000Z'),
    ]).toEqual([false, true]);
  });

  it('reads at the opening of a window even if the run-up read was an hour ago', () => {
    expect(dueMenuRefresh(at('2026-10-15T13:31:00.000Z'), WINDOWS, '2026-10-15T12:31:00.000Z')).toBe(true);
  });

  it('inside a window reads every 2 hours after that', () => {
    expect([
      dueMenuRefresh(at('2026-10-15T15:30:00.000Z'), WINDOWS, '2026-10-15T13:31:00.000Z'),
      dueMenuRefresh(at('2026-10-15T15:31:00.000Z'), WINDOWS, '2026-10-15T13:31:00.000Z'),
    ]).toEqual([false, true]);
  });

  it('never reads after the last window has closed', () => {
    expect(dueMenuRefresh(at('2026-10-16T22:31:00.000Z'), WINDOWS, null)).toBe(false);
  });

  it('has nothing to do without windows', () => {
    expect(dueMenuRefresh(at('2026-10-09T12:00:00.000Z'), [], null)).toBe(false);
  });
});
