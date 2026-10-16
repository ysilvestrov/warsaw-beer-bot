import { expectedOn, presenceIntervals, TABLE_MS } from './presence';

// Sessions as WFP22 has them: evening windows on two days.
const SESSIONS = [
  { session_no: 1, start_at: '2026-10-15T14:00:00.000Z', end_at: '2026-10-15T21:00:00.000Z' },
  { session_no: 2, start_at: '2026-10-16T12:00:00.000Z', end_at: '2026-10-16T21:00:00.000Z' },
];
const t = (iso: string) => Date.parse(iso);
const start = (telegramId: number, at: string) => ({ telegramId, kind: 'start' as const, at });
const end = (telegramId: number, at: string) => ({ telegramId, kind: 'end' as const, at });

describe('presenceIntervals', () => {
  it('a start and an end make one interval; a later start opens another', () => {
    const r = presenceIntervals([
      start(1, '2026-10-15T15:00:00.000Z'), end(1, '2026-10-15T17:00:00.000Z'), start(1, '2026-10-15T19:00:00.000Z'), end(1, '2026-10-15T20:00:00.000Z'),
    ], SESSIONS);
    expect(r.get(1)).toEqual([
      { from: t('2026-10-15T15:00:00.000Z'), to: t('2026-10-15T17:00:00.000Z') },
      { from: t('2026-10-15T19:00:00.000Z'), to: t('2026-10-15T20:00:00.000Z') },
    ]);
  });

  it('a start inside an open interval changes nothing, and an end with nothing open is ignored', () => {
    const r = presenceIntervals([
      end(1, '2026-10-15T14:30:00.000Z'), start(1, '2026-10-15T15:00:00.000Z'), start(1, '2026-10-15T16:00:00.000Z'), end(1, '2026-10-15T17:00:00.000Z'),
    ], SESSIONS);
    expect(r.get(1)).toEqual([{ from: t('2026-10-15T15:00:00.000Z'), to: t('2026-10-15T17:00:00.000Z') }]);
  });

  it('a forgotten end stops at the end of the session the day began in, and the next day starts afresh', () => {
    const r = presenceIntervals([start(1, '2026-10-15T15:00:00.000Z'), start(1, '2026-10-16T13:00:00.000Z')], SESSIONS);
    expect(r.get(1)).toEqual([
      { from: t('2026-10-15T15:00:00.000Z'), to: t('2026-10-15T21:00:00.000Z') },
      { from: t('2026-10-16T13:00:00.000Z'), to: t('2026-10-16T21:00:00.000Z') },
    ]);
  });

  it('a start after the last session lasts an instant', () => {
    const r = presenceIntervals([start(1, '2026-10-16T21:10:00.000Z')], SESSIONS);
    expect(r.get(1)).toEqual([{ from: t('2026-10-16T21:10:00.000Z'), to: t('2026-10-16T21:10:00.000Z') }]);
  });

  it('members are kept apart, and nobody with no events is present', () => {
    const r = presenceIntervals([start(1, '2026-10-15T15:00:00.000Z'), end(2, '2026-10-15T16:00:00.000Z')], SESSIONS);
    expect([[...r.keys()], r.get(2)]).toEqual([[1], undefined]);
  });
});

describe('expectedOn', () => {
  const ADDED = '2026-10-15T18:00:00.000Z';
  const intervals = presenceIntervals([
    start(1, '2026-10-15T15:00:00.000Z'), // at the table all evening
    start(2, '2026-10-15T18:10:00.000Z'), // came ten minutes after the glass
    start(3, '2026-10-15T15:00:00.000Z'), end(3, '2026-10-15T17:59:00.000Z'), // left just before it
    start(4, new Date(t(ADDED) + TABLE_MS).toISOString()), // came exactly as the glass left the table
    start(5, new Date(t(ADDED) + TABLE_MS + 1000).toISOString()), // a second later
  ], SESSIONS);

  it('waits for whoever was at the table at any moment of the 40 minutes after «Взяв», bounds included', () => {
    expect(expectedOn(intervals, ADDED).sort()).toEqual([1, 2, 4]);
  });

  it('waits for nobody when nobody was there', () => {
    expect(expectedOn(new Map(), ADDED)).toEqual([]);
  });
});
