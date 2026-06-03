import { filterInteresting, rankByRating, familyOf, topStyleFamilies, ABV_BUCKETS, bucketForRange } from './filters';

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

test('familyOf splits on the first " - " and trims', () => {
  expect(familyOf('IPA - American')).toBe('IPA');
  expect(familyOf('Sour - Fruited - Other')).toBe('Sour');
  expect(familyOf('Mead')).toBe('Mead');
  expect(familyOf('  Pilsner - German  ')).toBe('Pilsner');
  expect(familyOf(null)).toBeNull();
  expect(familyOf('')).toBeNull();
  expect(familyOf('   ')).toBeNull();
});

test('topStyleFamilies ranks present families by count, then alpha, caps at n', () => {
  const styles = [
    'IPA - American', 'IPA - Imperial', 'IPA - New England',  // IPA x3
    'Sour - Fruited', 'Sour - Other',                          // Sour x2
    'Lager - Pale',                                            // Lager x1
    'Stout - Imperial',                                        // Stout x1
    null, '',                                                  // ignored
  ];
  expect(topStyleFamilies(styles, [], 2)).toEqual(['IPA', 'Sour']);
  // count tie (Lager 1, Stout 1) breaks alphabetically
  expect(topStyleFamilies(styles, [], 4)).toEqual(['IPA', 'Sour', 'Lager', 'Stout']);
});

test('topStyleFamilies appends active families absent from the top-n (alpha)', () => {
  const styles = ['IPA - American', 'IPA - Imperial'];
  // Saison + Bock are active but not on tap → appended, alpha-sorted, after present
  expect(topStyleFamilies(styles, ['Saison', 'IPA', 'Bock'], 1)).toEqual(['IPA', 'Bock', 'Saison']);
});

test('topStyleFamilies on empty taps returns only active families', () => {
  expect(topStyleFamilies([], ['Stout'], 10)).toEqual(['Stout']);
  expect(topStyleFamilies([], [], 10)).toEqual([]);
});

test('ABV_BUCKETS are the four agreed single-select ranges', () => {
  expect(ABV_BUCKETS.map((b) => b.key)).toEqual(['0-5', '5-7', '7-9', '9plus']);
  expect(ABV_BUCKETS.map((b) => [b.min, b.max])).toEqual([
    [null, 5], [5, 7], [7, 9], [9, null],
  ]);
});

test('bucketForRange maps an exact (min,max) pair to its key, else null', () => {
  expect(bucketForRange(null, 5)).toBe('0-5');
  expect(bucketForRange(5, 7)).toBe('5-7');
  expect(bucketForRange(9, null)).toBe('9plus');
  expect(bucketForRange(null, null)).toBeNull();
  expect(bucketForRange(4, 6)).toBeNull();
});

test('rankByRating sorts desc and breaks ties by beer_id', () => {
  const sorted = rankByRating([
    { beer_id: 1, u_rating: 3.5 }, { beer_id: 2, u_rating: 4.0 },
    { beer_id: 3, u_rating: 4.0 },
  ]);
  expect(sorted.map((t) => t.beer_id)).toEqual([2, 3, 1]);
});
