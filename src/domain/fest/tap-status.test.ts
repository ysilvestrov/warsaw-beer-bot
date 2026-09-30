import { tapStatus } from './tap-status';

const NOW = new Date('2026-10-15T18:00:00.000Z');
const HOUR_AGO = '2026-10-15T17:00:00.000Z';
const VENUES = [11142155, 2815864, 2167060];
const full = { from_at: '2026-10-15T16:30:00.000Z', to_at: '2026-10-15T18:00:00.000Z' };
const allCovered = new Map(VENUES.map((v) => [v, [full]]));

const status = (checkins: { bid: number; checkin_at: string }[], coverage = allCovered) =>
  tapStatus({ bid: 42, checkins, coverageByVenue: coverage, venueIds: VENUES, now: NOW });

describe('tapStatus', () => {
  it('a check-in exactly an hour old has aged out', () => {
    expect(status([{ bid: 42, checkin_at: HOUR_AGO }])).toEqual({ kind: 'not_seen' });
  });

  it('a check-in one second younger than an hour counts', () => {
    expect(status([{ bid: 42, checkin_at: '2026-10-15T17:00:01.000Z' }]))
      .toEqual({ kind: 'on_tap', lastAt: '2026-10-15T17:00:01.000Z', count: 1 });
  });

  it('reports the latest check-in and how many there were', () => {
    expect(status([
      { bid: 42, checkin_at: '2026-10-15T17:10:00.000Z' },
      { bid: 42, checkin_at: '2026-10-15T17:50:00.000Z' },
      { bid: 7, checkin_at: '2026-10-15T17:55:00.000Z' },
    ])).toEqual({ kind: 'on_tap', lastAt: '2026-10-15T17:50:00.000Z', count: 2 });
  });

  it('ignores a check-in from the future relative to now', () => {
    expect(status([{ bid: 42, checkin_at: '2026-10-15T18:00:01.000Z' }])).toEqual({ kind: 'not_seen' });
  });

  it('no check-ins with every venue watched for the hour is "not seen"', () => {
    expect(status([])).toEqual({ kind: 'not_seen' });
  });

  it('a gap at just one of three venues makes it unknown', () => {
    const gapped = new Map(allCovered);
    gapped.set(2167060, [{ from_at: '2026-10-15T17:05:00.000Z', to_at: '2026-10-15T18:00:00.000Z' }]);
    expect(status([], gapped)).toEqual({ kind: 'unknown' });
  });

  it('a venue with no coverage at all makes it unknown', () => {
    const missing = new Map(allCovered);
    missing.delete(2815864);
    expect(status([], missing)).toEqual({ kind: 'unknown' });
  });

  it('a check-in at the stadium venue counts like one at the festival venue', () => {
    // Venue is not an input: every festival venue's check-ins are passed in together.
    expect(status([{ bid: 42, checkin_at: '2026-10-15T17:30:00.000Z' }], new Map())).toEqual({ kind: 'on_tap', lastAt: '2026-10-15T17:30:00.000Z', count: 1 });
  });

  it('with no venues configured nothing can be proven unseen', () => {
    expect(tapStatus({ bid: 42, checkins: [], coverageByVenue: new Map(), venueIds: [], now: NOW })).toEqual({ kind: 'unknown' });
  });
});
