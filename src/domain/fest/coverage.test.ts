import { isCovered, pageSpan, touches } from './coverage';

const NOW = '2026-10-15T16:00:00.000Z';

describe('pageSpan', () => {
  it('head page proves [oldest on page, fetchedAt]', () => {
    expect(pageSpan({
      checkinTimes: ['2026-10-15T15:50:00.000Z', '2026-10-15T15:20:00.000Z'],
      cursorAt: null, fetchedAt: '2026-10-15T15:59:30.000Z', now: NOW,
    })).toEqual({ from_at: '2026-10-15T15:20:00.000Z', to_at: '2026-10-15T15:59:30.000Z' });
  });

  it('cursor page proves [oldest on page, cursor time]', () => {
    expect(pageSpan({
      checkinTimes: ['2026-10-15T15:10:00.000Z', '2026-10-15T14:40:00.000Z'],
      cursorAt: '2026-10-15T15:20:00.000Z', fetchedAt: '2026-10-15T15:59:30.000Z', now: NOW,
    })).toEqual({ from_at: '2026-10-15T14:40:00.000Z', to_at: '2026-10-15T15:20:00.000Z' });
  });

  it('an empty page proves nothing', () => {
    expect(pageSpan({ checkinTimes: [], cursorAt: null, fetchedAt: NOW, now: NOW })).toBeNull();
  });

  it('clips an eye clock running ahead to the server now', () => {
    expect(pageSpan({
      checkinTimes: ['2026-10-15T15:20:00.000Z'],
      cursorAt: null, fetchedAt: '2026-10-15T16:05:00.000Z', now: NOW,
    })).toEqual({ from_at: '2026-10-15T15:20:00.000Z', to_at: NOW });
  });

  it('clips a cursor time in the future to the server now', () => {
    expect(pageSpan({
      checkinTimes: ['2026-10-15T15:20:00.000Z'],
      cursorAt: '2026-10-15T18:00:00.000Z', fetchedAt: NOW, now: NOW,
    })).toEqual({ from_at: '2026-10-15T15:20:00.000Z', to_at: NOW });
  });

  it('proves nothing when the upper bound is older than the page (inconsistent input)', () => {
    expect(pageSpan({
      checkinTimes: ['2026-10-15T15:20:00.000Z'],
      cursorAt: '2026-10-15T15:00:00.000Z', fetchedAt: NOW, now: NOW,
    })).toBeNull();
  });
});

describe('isCovered', () => {
  const a = { from_at: '2026-10-15T15:00:00.000Z', to_at: '2026-10-15T15:30:00.000Z' };
  const b = { from_at: '2026-10-15T15:30:00.000Z', to_at: '2026-10-15T16:00:00.000Z' };

  it('treats exactly touching spans as continuous', () => {
    expect(isCovered([b, a], '2026-10-15T15:00:00.000Z', '2026-10-15T16:00:00.000Z')).toBe(true);
  });

  it('a one-second gap breaks coverage', () => {
    const gapped = { from_at: '2026-10-15T15:30:01.000Z', to_at: '2026-10-15T16:00:00.000Z' };
    expect(isCovered([a, gapped], '2026-10-15T15:00:00.000Z', '2026-10-15T16:00:00.000Z')).toBe(false);
  });

  it('no spans cover nothing', () => {
    expect(isCovered([], '2026-10-15T15:00:00.000Z', '2026-10-15T15:00:01.000Z')).toBe(false);
  });

  it('a window reaching past the last span is not covered', () => {
    expect(isCovered([a, b], '2026-10-15T15:10:00.000Z', '2026-10-15T16:00:01.000Z')).toBe(false);
  });
});

describe('touches', () => {
  const have = [{ from_at: '2026-10-15T15:00:00.000Z', to_at: '2026-10-15T15:30:00.000Z' }];

  it('an adjoining span stitches', () => {
    expect(touches(have, { from_at: '2026-10-15T15:30:00.000Z', to_at: '2026-10-15T15:45:00.000Z' })).toBe(true);
  });

  it('a span after a gap does not stitch', () => {
    expect(touches(have, { from_at: '2026-10-15T15:30:01.000Z', to_at: '2026-10-15T15:45:00.000Z' })).toBe(false);
  });

  it('nothing stitches onto no coverage', () => {
    expect(touches([], { from_at: '2026-10-15T15:30:00.000Z', to_at: '2026-10-15T15:45:00.000Z' })).toBe(false);
  });
});
