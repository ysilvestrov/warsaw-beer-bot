import { untappdRating } from './rating';

describe('untappdRating (#616)', () => {
  test.each([
    [0, null], ['0', null], [-1, null], ['N/A', null], ['', null], [undefined, null], [null, null], [Number.NaN, null], [{}, null],
    [3.29971, 3.3], ['4.26404', 4.26], [4.06, 4.06], [3, 3], [4.995, 5],
  ])('%p → %p', (input, expected) => {
    expect(untappdRating(input)).toBe(expected);
  });
});
