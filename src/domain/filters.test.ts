import { filterInteresting, rankByRating } from './filters';

const taps = [
  { beer_id: 1, style: 'IPA',   abv: 6.1, u_rating: 4.0 },
  { beer_id: 2, style: 'Pils',  abv: 5.0, u_rating: 3.5 },
  { beer_id: 3, style: 'IPA',   abv: 7.5, u_rating: 3.9 },
  { beer_id: null, style: 'x',  abv: 4,   u_rating: 3.0 },
];
const tried = new Set([1]);

test('filterInteresting respects checkins + style + rating + abv', () => {
  const out = filterInteresting(taps, tried, {
    styles: ['IPA'], min_rating: 3.8, abv_min: 4, abv_max: 8,
  });
  expect(out.map((t) => t.beer_id)).toEqual([3]);
});

test('rankByRating sorts desc and breaks ties by beer_id', () => {
  const sorted = rankByRating([
    { beer_id: 1, u_rating: 3.5 }, { beer_id: 2, u_rating: 4.0 },
    { beer_id: 3, u_rating: 4.0 },
  ]);
  expect(sorted.map((t) => t.beer_id)).toEqual([2, 3, 1]);
});
