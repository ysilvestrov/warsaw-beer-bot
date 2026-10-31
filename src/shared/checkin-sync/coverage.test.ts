import { mergeRange, rangeContaining } from './coverage';

describe('mergeRange', () => {
  it('adds a range to empty coverage', () => {
    expect(mergeRange([], 100, 200)).toEqual([{ from_id: 100, to_id: 200 }]);
  });

  it('merges ranges that touch (200 and 201 leave no id between them)', () => {
    expect(mergeRange([{ from_id: 100, to_id: 200 }], 201, 300)).toEqual([{ from_id: 100, to_id: 300 }]);
    expect(mergeRange([{ from_id: 201, to_id: 300 }], 100, 200)).toEqual([{ from_id: 100, to_id: 300 }]);
  });

  it('keeps ranges apart across a one-id gap (that id is a check-in we never saw)', () => {
    expect(mergeRange([{ from_id: 100, to_id: 200 }], 202, 300)).toEqual([
      { from_id: 202, to_id: 300 },
      { from_id: 100, to_id: 200 },
    ]);
  });

  it('swallows a range it contains and is swallowed by one that contains it', () => {
    expect(mergeRange([{ from_id: 150, to_id: 160 }], 100, 200)).toEqual([{ from_id: 100, to_id: 200 }]);
    expect(mergeRange([{ from_id: 100, to_id: 200 }], 150, 160)).toEqual([{ from_id: 100, to_id: 200 }]);
  });

  it('bridges three ranges into one and leaves an untouched one alone', () => {
    const ranges = [
      { from_id: 500, to_id: 600 },
      { from_id: 300, to_id: 350 },
      { from_id: 200, to_id: 250 },
      { from_id: 10, to_id: 20 },
    ];
    expect(mergeRange(ranges, 251, 499)).toEqual([
      { from_id: 200, to_id: 600 },
      { from_id: 10, to_id: 20 },
    ]);
  });

  it('does not mutate its input', () => {
    const ranges = [{ from_id: 100, to_id: 200 }];
    mergeRange(ranges, 201, 300);
    expect(ranges).toEqual([{ from_id: 100, to_id: 200 }]);
  });

  it.each([
    [5, 4],
    [1.5, 4],
    [1, Number.NaN],
  ])('refuses %s..%s like addCoverage does', (from, to) => {
    expect(() => mergeRange([], from, to)).toThrow(`invalid coverage range: ${from}..${to}`);
  });
});

describe('rangeContaining', () => {
  const ranges = [{ from_id: 300, to_id: 400 }, { from_id: 100, to_id: 200 }];

  it('finds the range holding the id, ends included', () => {
    expect(rangeContaining(ranges, 100)).toEqual({ from_id: 100, to_id: 200 });
    expect(rangeContaining(ranges, 400)).toEqual({ from_id: 300, to_id: 400 });
  });

  it('returns null in a gap and on empty coverage', () => {
    expect(rangeContaining(ranges, 250)).toBeNull();
    expect(rangeContaining([], 250)).toBeNull();
  });
});
