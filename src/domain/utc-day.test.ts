import { describe, it, expect } from 'vitest';
import { utcDay } from './utc-day';

describe('utcDay', () => {
  it('formats a date as a UTC YYYY-MM-DD key', () => {
    expect(utcDay(new Date('2026-07-26T12:34:56Z'))).toBe('2026-07-26');
  });

  it('does not shift the day for late-evening UTC instants', () => {
    // 23:59 UTC is still the same UTC day (a Pacific-keyed formatter would
    // have reported the previous day here).
    expect(utcDay(new Date('2026-07-26T23:59:59Z'))).toBe('2026-07-26');
  });

  it('rolls over exactly at UTC midnight', () => {
    expect(utcDay(new Date('2026-07-27T00:00:00Z'))).toBe('2026-07-27');
  });
});
