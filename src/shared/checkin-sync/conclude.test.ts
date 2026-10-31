import { conclude } from './conclude';

describe('conclude', () => {
  it('is caught up when the count reaches the profile total and coverage is one range', () => {
    expect(conclude({ count: 3, profileTotal: 3, ranges: [{ from_id: 580, to_id: 600 }], oldest: 580 }))
      .toEqual({ caughtUp: true, nextCursor: null });
  });

  it('is not caught up on counts alone when coverage has a hole (profile total shrank)', () => {
    const ranges = [{ from_id: 590, to_id: 600 }, { from_id: 200, to_id: 300 }];
    expect(conclude({ count: 4, profileTotal: 2, ranges, oldest: 590 })).toEqual({ caughtUp: false, nextCursor: '590' });
  });

  it('is not caught up without a profile total', () => {
    expect(conclude({ count: 3, profileTotal: null, ranges: [{ from_id: 580, to_id: 600 }], oldest: 580 }))
      .toEqual({ caughtUp: false, nextCursor: '580' });
  });

  it('is not caught up below the profile total', () => {
    expect(conclude({ count: 2, profileTotal: 3, ranges: [{ from_id: 580, to_id: 600 }], oldest: 580 }))
      .toEqual({ caughtUp: false, nextCursor: '580' });
  });

  it('jumps to the bottom of the range that holds the page\'s oldest id', () => {
    expect(conclude({ count: 5, profileTotal: 10, ranges: [{ from_id: 100, to_id: 600 }], oldest: 500 }))
      .toEqual({ caughtUp: false, nextCursor: '100' });
  });

  it('falls back to the oldest id when no range holds it', () => {
    expect(conclude({ count: 2, profileTotal: 10, ranges: [], oldest: 580 })).toEqual({ caughtUp: false, nextCursor: '580' });
  });
});
