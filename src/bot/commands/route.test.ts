import { filterRouteTaps } from './route';

test('route candidates always require a real Untappd match', () => {
  const taps = [
    { beer_id: 1, untappd_id: null, style: 'IPA', abv: 6, u_rating: null },
    { beer_id: 2, untappd_id: 2002, style: 'IPA', abv: 6, u_rating: 4 },
  ];
  expect(filterRouteTaps(taps, new Set(), {}).map((tap) => tap.beer_id)).toEqual([2]);
});
