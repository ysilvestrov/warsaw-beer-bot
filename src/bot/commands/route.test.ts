import { filterRouteTaps, clampRouteN, MAX_ROUTE_N } from './route';

describe('clampRouteN', () => {
  it('passes small positive N through', () => {
    expect(clampRouteN(5)).toBe(5);
  });
  it('caps N at MAX_ROUTE_N', () => {
    expect(clampRouteN(200)).toBe(MAX_ROUTE_N);
    expect(MAX_ROUTE_N).toBe(70);
  });
  it('floors N to at least 1', () => {
    expect(clampRouteN(0)).toBe(1);
    expect(clampRouteN(-4)).toBe(1);
  });
});

test('route candidates always require a real Untappd match', () => {
  const taps = [
    { beer_id: 1, untappd_id: null, style: 'IPA', abv: 6, u_rating: null },
    { beer_id: 2, untappd_id: 2002, style: 'IPA', abv: 6, u_rating: 4 },
  ];
  expect(filterRouteTaps(taps, new Set(), {}).map((tap) => tap.beer_id)).toEqual([2]);
});
