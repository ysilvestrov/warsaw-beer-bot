import { filterInteresting, rankByRating, topStyleFamilies, ABV_PRESETS, bucketForRange, formatAbvRange } from './filters';

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

test('filterInteresting optionally requires a real Untappd match', () => {
  const rows = [
    { beer_id: 10, untappd_id: null, style: 'IPA', abv: 6, u_rating: null },
    { beer_id: 11, untappd_id: 1011, style: 'IPA', abv: 6, u_rating: 4 },
  ];

  expect(filterInteresting(rows, new Set(), {}).map((r) => r.beer_id))
    .toEqual([10, 11]);
  expect(filterInteresting(rows, new Set(), { require_untappd_match: true }).map((r) => r.beer_id))
    .toEqual([11]);
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

test('ABV_PRESETS are the open-ended threshold presets', () => {
  expect(ABV_PRESETS.map((b) => b.key)).toEqual(['lte3_5', 'lte5', 'gte5', 'gte7', 'gte9']);
  expect(ABV_PRESETS.map((b) => [b.min, b.max])).toEqual([
    [null, 3.5], [null, 5], [5, null], [7, null], [9, null],
  ]);
});

test('formatAbvRange renders caps, floors, bounded (stale), and null', () => {
  expect(formatAbvRange(null, 3.5)).toBe('≤3.5%');
  expect(formatAbvRange(null, 5)).toBe('≤5%');
  expect(formatAbvRange(5, null)).toBe('5%+');
  expect(formatAbvRange(9, null)).toBe('9%+');
  expect(formatAbvRange(5, 7)).toBe('5–7%'); // stale bounded range stays visible
  expect(formatAbvRange(null, null)).toBeNull();
});

test('bucketForRange maps an exact (min,max) pair to its preset key, else null', () => {
  expect(bucketForRange(null, 3.5)).toBe('lte3_5');
  expect(bucketForRange(null, 5)).toBe('lte5');
  expect(bucketForRange(5, null)).toBe('gte5');
  expect(bucketForRange(7, null)).toBe('gte7');
  expect(bucketForRange(9, null)).toBe('gte9');
  expect(bucketForRange(5, 7)).toBeNull(); // stale old band
  expect(bucketForRange(7, 9)).toBeNull(); // stale old band
  expect(bucketForRange(null, null)).toBeNull();
});

test('filterInteresting matches styles by family, not substring', () => {
  const rows = [
    { beer_id: 10, style: 'IPA - American',      abv: 6, u_rating: 4 },
    { beer_id: 11, style: 'Pale Ale - American', abv: 5, u_rating: 4 },
    { beer_id: 12, style: 'Stout - Imperial',    abv: 9, u_rating: 4 },
    { beer_id: 13, style: null,                  abv: 5, u_rating: 4 },
  ];
  // selecting 'IPA' yields only the IPA family
  expect(filterInteresting(rows, new Set(), { styles: ['IPA'] }).map((r) => r.beer_id)).toEqual([10]);
  // 'Ale' must NOT substring-match 'Pale Ale' anymore
  expect(filterInteresting(rows, new Set(), { styles: ['Ale'] }).map((r) => r.beer_id)).toEqual([]);
  // case-insensitive family match
  expect(filterInteresting(rows, new Set(), { styles: ['stout'] }).map((r) => r.beer_id)).toEqual([12]);
  // null style never matches a selected family
  expect(filterInteresting(rows, new Set(), { styles: ['IPA', 'Stout'] }).map((r) => r.beer_id)).toEqual([10, 12]);
});

test('rankByRating sorts desc and breaks ties by beer_id', () => {
  const sorted = rankByRating([
    { beer_id: 1, u_rating: 3.5 }, { beer_id: 2, u_rating: 4.0 },
    { beer_id: 3, u_rating: 4.0 },
  ]);
  expect(sorted.map((t) => t.beer_id)).toEqual([2, 3, 1]);
});
